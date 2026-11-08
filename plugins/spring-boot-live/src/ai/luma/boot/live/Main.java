/*
 * Luma's Spring Boot live data sidecar: attaches to local JVMs (Attach API, the same user only),
 * starts their local JMX agent when needed (no TCP port is opened) and reads Spring Boot's
 * Actuator endpoints and Admin MBean over JMX. One JSON request per stdin line, one JSON
 * response per stdout line:
 *
 *   {"id":1,"method":"attach","params":{"pid":"123"}}        -> {"id":1,"result":{"handle":"h1"}}
 *   {"id":2,"method":"attach","params":{"marker":"run:7","hint":"com.example.App"}}
 *   {"id":3,"method":"status","params":{"handle":"h1"}}      -> {"ready":true,"port":"8080",...}
 *   {"id":4,"method":"endpoint","params":{"handle":"h1","name":"Beans"}}
 *   {"id":5,"method":"detach","params":{"handle":"h1"}}
 *
 * Errors: {"id":n,"error":{"kind":"...","message":"..."}}; kinds: attachFailed, jmxNotLoaded,
 * actuatorMissing, endpointNotExposed, notFound, failed.
 */
package ai.luma.boot.live;

import com.sun.tools.attach.VirtualMachine;
import com.sun.tools.attach.VirtualMachineDescriptor;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Array;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import javax.management.MBeanInfo;
import javax.management.MBeanOperationInfo;
import javax.management.MBeanServerConnection;
import javax.management.ObjectName;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.TabularData;
import javax.management.remote.JMXConnector;
import javax.management.remote.JMXConnectorFactory;
import javax.management.remote.JMXServiceURL;

public final class Main {
    private static final String CONNECTOR = "com.sun.management.jmxremote.localConnectorAddress";
    private static final String ADMIN = "org.springframework.boot:type=Admin,name=SpringApplication";

    private record Connection(String pid, JMXConnector connector, MBeanServerConnection server) {}

    private static final Map<String, Connection> connections = new ConcurrentHashMap<>();
    private static final AtomicInteger handles = new AtomicInteger();
    private static final PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);

    static final class Failure extends Exception {
        final String kind;

        Failure(String kind, String message) {
            super(message);
            this.kind = kind;
        }
    }

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) continue;
            Object id = null;
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> request = (Map<String, Object>) Json.parse(line);
                id = request.get("id");
                @SuppressWarnings("unchecked")
                Map<String, Object> params = (Map<String, Object>) request.getOrDefault("params", Map.of());
                Object result = handle(String.valueOf(request.get("method")), params);
                respond(id, "result", result);
            } catch (Failure f) {
                respond(id, "error", Map.of("kind", f.kind, "message", String.valueOf(f.getMessage())));
            } catch (Throwable t) {
                Throwable root = t;
                while (root.getCause() != null) root = root.getCause();
                respond(id, "error", Map.of("kind", "failed", "message", root.getClass().getSimpleName() + ": " + root.getMessage()));
            }
        }
        for (Connection c : connections.values()) close(c);
    }

    private static synchronized void respond(Object id, String key, Object value) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put(key, value);
        out.println(Json.write(m));
    }

    private static Object handle(String method, Map<String, Object> params) throws Exception {
        switch (method) {
            case "attach": {
                Object pid = params.get("pid");
                String handle = pid != null
                    ? connect(String.valueOf(pid))
                    : connectMarked(String.valueOf(params.get("marker")), (String) params.get("hint"));
                return Map.of("handle", handle);
            }
            case "status":
                return status(connection(params));
            case "endpoint":
                return endpoint(connection(params), String.valueOf(params.get("name")));
            case "detach": {
                Connection c = connections.remove(String.valueOf(params.get("handle")));
                if (c != null) close(c);
                return Map.of();
            }
            case "ping":
                return Map.of("version", System.getProperty("java.version"));
            default:
                throw new Failure("failed", "Unknown method " + method);
        }
    }

    private static Connection connection(Map<String, Object> params) throws Failure {
        Connection c = connections.get(String.valueOf(params.get("handle")));
        if (c == null) throw new Failure("notFound", "Not attached");
        return c;
    }

    /** The local JMX connector of process `pid`, starting its management agent if needed. */
    private static String connect(String pid) throws Exception {
        VirtualMachine vm;
        try {
            vm = VirtualMachine.attach(pid);
        } catch (Exception e) {
            throw new Failure("attachFailed", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        try {
            String address = vm.getAgentProperties().getProperty(CONNECTOR);
            if (address == null) address = vm.startLocalManagementAgent();
            if (address == null) throw new Failure("jmxNotLoaded", "JMX agent not loaded");
            JMXConnector connector = JMXConnectorFactory.connect(new JMXServiceURL(address));
            String handle = "h" + handles.incrementAndGet();
            connections.put(handle, new Connection(pid, connector, connector.getMBeanServerConnection()));
            return handle;
        } finally {
            vm.detach();
        }
    }

    /** Attaches to the JVM started with `-Dluma.run.session=<marker>` (a build tool's fork). */
    private static String connectMarked(String marker, String hint) throws Exception {
        String self = String.valueOf(ProcessHandle.current().pid());
        List<VirtualMachineDescriptor> all = VirtualMachine.list();
        List<VirtualMachineDescriptor> ordered = new ArrayList<>();
        // The JVMs running the main class first: attaching is not free.
        for (VirtualMachineDescriptor d : all) if (hint != null && d.displayName().startsWith(hint)) ordered.add(d);
        for (VirtualMachineDescriptor d : all) if (!ordered.contains(d)) ordered.add(d);
        for (VirtualMachineDescriptor d : ordered) {
            if (d.id().equals(self)) continue;
            try {
                VirtualMachine vm = VirtualMachine.attach(d);
                try {
                    if (marker.equals(vm.getSystemProperties().getProperty("luma.run.session"))) {
                        vm.detach();
                        return connect(d.id());
                    }
                } finally {
                    try {
                        vm.detach();
                    } catch (Exception ignored) {
                        // Detached already.
                    }
                }
            } catch (Failure f) {
                throw f;
            } catch (Exception ignored) {
                // Another user's JVM, or one that went away.
            }
        }
        throw new Failure("attachFailed", "No running JVM has luma.run.session=" + marker);
    }

    private static void close(Connection c) {
        try {
            c.connector().close();
        } catch (Exception ignored) {
            // Gone.
        }
    }

    private static Map<String, Object> status(Connection c) throws Exception {
        MBeanServerConnection s = c.server();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("pid", c.pid());
        ObjectName admin = new ObjectName(ADMIN);
        boolean hasAdmin = s.isRegistered(admin);
        m.put("admin", hasAdmin);
        if (hasAdmin) {
            m.put("ready", s.getAttribute(admin, "Ready"));
            m.put("port", property(s, admin, "local.server.port"));
            m.put("contextPath", property(s, admin, "server.servlet.context-path"));
            m.put("bootVersion", property(s, admin, "spring.boot.version"));
        } else {
            m.put("ready", false);
        }
        List<String> endpoints = new ArrayList<>();
        Set<ObjectName> names = s.queryNames(new ObjectName("*:type=Endpoint,*"), null);
        String domain = null;
        for (ObjectName n : names) {
            endpoints.add(n.getKeyProperty("name"));
            if (domain == null) domain = n.getDomain();
        }
        m.put("domain", domain);
        m.put("endpoints", endpoints);
        return m;
    }

    private static Object property(MBeanServerConnection s, ObjectName admin, String key) {
        try {
            return s.invoke(admin, "getProperty", new Object[] {key}, new String[] {String.class.getName()});
        } catch (Exception e) {
            return null;
        }
    }

    /** The read operation of Actuator endpoint `name` (`Beans`, `Health`, `Mappings`, `Env`, `Conditions`). */
    private static Object endpoint(Connection c, String name) throws Exception {
        MBeanServerConnection s = c.server();
        Set<ObjectName> names = s.queryNames(new ObjectName("*:type=Endpoint,name=" + name), null);
        if (names.isEmpty()) {
            boolean any = !s.queryNames(new ObjectName("*:type=Endpoint,*"), null).isEmpty();
            if (!any && !s.isRegistered(new ObjectName(ADMIN)))
                throw new Failure("actuatorMissing", "Spring Boot Actuator is not enabled.");
            throw new Failure("endpointNotExposed", name);
        }
        ObjectName target = names.iterator().next();
        MBeanInfo info = s.getMBeanInfo(target);
        // The endpoint's main read operation: not a `…Entry(selector)` one, the fewest parameters
        // (Env: `environment(pattern)` with a nullable pattern, not `environmentEntry(toMatch)`).
        MBeanOperationInfo best = null;
        for (MBeanOperationInfo op : info.getOperations()) {
            if (op.getImpact() == MBeanOperationInfo.ACTION) continue;
            if (best == null || rank(op) < rank(best)) best = op;
        }
        if (best == null) throw new Failure("failed", "No read operation on " + target);
        Object[] args = new Object[best.getSignature().length];
        String[] types = new String[args.length];
        for (int i = 0; i < args.length; i++) types[i] = best.getSignature()[i].getType();
        return s.invoke(target, best.getName(), args, types);
    }

    private static int rank(MBeanOperationInfo op) {
        return (op.getName().endsWith("Entry") ? 100 : 0) + op.getSignature().length;
    }

    /** A small JSON reader and writer (no dependencies). */
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) {
            this.s = s;
        }

        static Object parse(String text) {
            Json j = new Json(text);
            Object v = j.value();
            j.ws();
            if (j.i != j.s.length()) throw new IllegalArgumentException("Trailing text at " + j.i);
            return v;
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private Object value() {
            ws();
            char c = s.charAt(i);
            switch (c) {
                case '{': {
                    i++;
                    Map<String, Object> m = new LinkedHashMap<>();
                    ws();
                    if (s.charAt(i) == '}') {
                        i++;
                        return m;
                    }
                    while (true) {
                        ws();
                        String k = string();
                        ws();
                        i++; // :
                        m.put(k, value());
                        ws();
                        if (s.charAt(i++) == '}') return m;
                    }
                }
                case '[': {
                    i++;
                    List<Object> l = new ArrayList<>();
                    ws();
                    if (s.charAt(i) == ']') {
                        i++;
                        return l;
                    }
                    while (true) {
                        l.add(value());
                        ws();
                        if (s.charAt(i++) == ']') return l;
                    }
                }
                case '"':
                    return string();
                case 't':
                    i += 4;
                    return Boolean.TRUE;
                case 'f':
                    i += 5;
                    return Boolean.FALSE;
                case 'n':
                    i += 4;
                    return null;
                default: {
                    int start = i;
                    while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
                    String n = s.substring(start, i);
                    if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
                    return Long.parseLong(n);
                }
            }
        }

        private String string() {
            StringBuilder b = new StringBuilder();
            i++; // "
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c != '\\') {
                    b.append(c);
                    continue;
                }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> b.append('\n');
                    case 't' -> b.append('\t');
                    case 'r' -> b.append('\r');
                    case 'b' -> b.append('\b');
                    case 'f' -> b.append('\f');
                    case 'u' -> {
                        b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                    }
                    default -> b.append(e);
                }
            }
        }

        static String write(Object v) {
            StringBuilder b = new StringBuilder();
            write(v, b, 0);
            return b.toString();
        }

        private static void write(Object v, StringBuilder b, int depth) {
            if (depth > 64) {
                quote("…", b);
                return;
            }
            if (v == null) {
                b.append("null");
            } else if (v instanceof Boolean || v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) {
                b.append(v);
            } else if (v instanceof Number n) {
                double d = n.doubleValue();
                if (Double.isFinite(d)) b.append(v);
                else quote(String.valueOf(v), b);
            } else if (v instanceof CharSequence || v instanceof Character || v instanceof Enum<?>) {
                quote(v.toString(), b);
            } else if (v instanceof Map<?, ?> m) {
                b.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : m.entrySet()) {
                    if (!first) b.append(',');
                    first = false;
                    quote(String.valueOf(e.getKey()), b);
                    b.append(':');
                    write(e.getValue(), b, depth + 1);
                }
                b.append('}');
            } else if (v instanceof CompositeData cd) {
                Map<String, Object> m = new LinkedHashMap<>();
                for (String k : cd.getCompositeType().keySet()) m.put(k, cd.get(k));
                write(m, b, depth);
            } else if (v instanceof TabularData td) {
                write(new ArrayList<Object>(td.values()), b, depth);
            } else if (v instanceof Collection<?> c) {
                b.append('[');
                boolean first = true;
                for (Object o : c) {
                    if (!first) b.append(',');
                    first = false;
                    write(o, b, depth + 1);
                }
                b.append(']');
            } else if (v.getClass().isArray()) {
                List<Object> l = new ArrayList<>();
                for (int k = 0; k < Array.getLength(v); k++) l.add(Array.get(v, k));
                write(l, b, depth);
            } else {
                quote(String.valueOf(v), b);
            }
        }

        private static void quote(String s, StringBuilder b) {
            b.append('"');
            for (int k = 0; k < s.length(); k++) {
                char c = s.charAt(k);
                switch (c) {
                    case '"' -> b.append("\\\"");
                    case '\\' -> b.append("\\\\");
                    case '\n' -> b.append("\\n");
                    case '\r' -> b.append("\\r");
                    case '\t' -> b.append("\\t");
                    default -> {
                        if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                    }
                }
            }
            b.append('"');
        }
    }
}
