package ai.luma.spring;

import java.net.URI;
import java.nio.file.Path;
import java.util.*;
import java.util.zip.ZipFile;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.lsp4j.Location;

/**
 * The Spring beans a project's libraries contribute (Luma's Spring model, library side).
 *
 * <p>{@code luma.spring.library [uri]}: for the Java project of {@code uri}, the
 * auto-configuration classes its classpath registers ({@code AutoConfiguration.imports},
 * {@code spring.factories}), with their {@code @Import}ed and nested configurations, their
 * {@code @Bean} methods and {@code @EnableConfigurationProperties} beans, and the conditions on
 * them. Class conditions ({@code @ConditionalOnClass}, {@code OnMissingClass}) and the web
 * application type are decided here (the classpath is JDT's); the others are returned for the
 * client, which knows the project's own beans and configuration. Bean types come with their
 * supertypes. Cached per project by its classpath (archive paths, sizes, modification times).
 *
 * <p>{@code luma.spring.locate [handle]}: the location of a library element (a class file,
 * opened from its source attachment or decompiled).
 */
public final class LibraryCommand implements IDelegateCommandHandler {
    private static final String BEAN = "org.springframework.context.annotation.Bean";
    private static final String CONFIGURATION = "org.springframework.context.annotation.Configuration";
    private static final String AUTO_CONFIGURATION = "org.springframework.boot.autoconfigure.AutoConfiguration";
    private static final String IMPORT = "org.springframework.context.annotation.Import";
    private static final String PRIMARY = "org.springframework.context.annotation.Primary";
    private static final String ENABLE_PROPERTIES = "org.springframework.boot.context.properties.EnableConfigurationProperties";
    private static final String PROPERTIES = "org.springframework.boot.context.properties.ConfigurationProperties";
    private static final String CONDITION_PACKAGE = "org.springframework.boot.autoconfigure.condition.";
    private static final String IMPORTS_FILE = "META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports";
    private static final String FACTORIES_KEY = "org.springframework.boot.autoconfigure.EnableAutoConfiguration";
    private static final int MAX_CONFIGURATIONS = 5000, MAX_PROJECTS = 8;
    private static final Map<String, Snapshot> CACHE = new LinkedHashMap<>();

    private record Snapshot(String fingerprint, Map<String, Object> result) {}

    @Override
    public Object executeCommand(String command, List<Object> args, IProgressMonitor monitor) throws Exception {
        if ("luma.spring.locate".equals(command)) return locate((String) args.get(0));
        String uri = (String) args.get(0);
        IJavaProject project = project(uri);
        if (project == null) return Map.of("incomplete", true, "configurations", List.of());
        return library(project, monitor);
    }

    private static Location locate(String handle) throws JavaModelException {
        IJavaElement element = JavaCore.create(handle);
        if (element == null || !element.exists()) return null;
        Location result = JDTUtils.toLocation(element);
        if (result == null && element instanceof IMember member && member.getClassFile() != null)
            result = JDTUtils.toLocation(member.getClassFile());
        return result;
    }

    static IJavaProject project(String uri) {
        ITypeRoot root = JDTUtils.resolveTypeRoot(uri);
        if (root != null) return root.getJavaProject();
        Path path;
        try { path = Path.of(URI.create(uri)).toFile().getCanonicalFile().toPath(); } catch (Exception e) { return null; }
        IJavaProject best = null;
        int length = -1;
        for (var p : ResourcesPlugin.getWorkspace().getRoot().getProjects()) {
            if (!p.isOpen() || p.getLocation() == null) continue;
            var candidate = JavaCore.create(p);
            Path dir;
            try { dir = p.getLocation().toFile().getCanonicalFile().toPath(); } catch (java.io.IOException e) { continue; }
            if (candidate.exists() && path.startsWith(dir) && dir.getNameCount() > length) {
                best = candidate;
                length = dir.getNameCount();
            }
        }
        return best;
    }

    private static void check(IProgressMonitor monitor) { if (monitor.isCanceled()) throw new OperationCanceledException(); }

    private static synchronized Map<String, Object> library(IJavaProject project, IProgressMonitor monitor) throws Exception {
        List<java.io.File> jars = new ArrayList<>();
        StringBuilder fingerprint = new StringBuilder();
        for (IPackageFragmentRoot root : project.getAllPackageFragmentRoots()) {
            if (!root.isArchive() || root.getPath() == null) continue;
            java.io.File file = root.getPath().toFile();
            if (!file.isFile()) continue;
            jars.add(file);
            fingerprint.append(file).append(':').append(file.length()).append(':').append(file.lastModified()).append('\n');
        }
        String key = project.getHandleIdentifier();
        Snapshot cached = CACHE.get(key);
        if (cached != null && cached.fingerprint.contentEquals(fingerprint)) return cached.result;
        Map<String, Object> result = new Builder(project, monitor).build(jars);
        CACHE.remove(key);
        CACHE.put(key, new Snapshot(fingerprint.toString(), result));
        while (CACHE.size() > MAX_PROJECTS) CACHE.remove(CACHE.keySet().iterator().next());
        return result;
    }

    /** A configuration to read: where it was registered and the conditions it inherits. */
    private record Pending(String fqn, String jar, String source, List<Map<String, Object>> inherited) {}

    /** Connection pools Boot's `DataSourceBuilder` knows (`PooledDataSourceCondition`). */
    private static final List<String> POOLS = List.of("com.zaxxer.hikari.HikariDataSource",
            "org.apache.tomcat.jdbc.pool.DataSource", "org.apache.commons.dbcp2.BasicDataSource",
            "oracle.ucp.jdbc.PoolDataSourceImpl", "org.springframework.jdbc.datasource.SimpleDriverDataSource");
    /** Embedded databases (`EmbeddedDatabaseConnection`). */
    private static final List<String> EMBEDDED = List.of("org.h2.Driver", "org.hsqldb.jdbc.JDBCDriver",
            "org.apache.derby.jdbc.EmbeddedDriver");

    private static final class Builder {
        final IJavaProject project;
        final IProgressMonitor monitor;
        final Map<String, IType> types = new HashMap<>();
        final Map<String, List<String>> supertypes = new TreeMap<>();
        final String web;
        boolean incomplete;

        Builder(IJavaProject project, IProgressMonitor monitor) {
            this.project = project;
            this.monitor = monitor;
            this.web = webType();
        }

        IType type(String fqn) {
            return types.computeIfAbsent(fqn, name -> {
                try {
                    IType t = project.findType(name.replace('$', '.'));
                    return t != null && t.exists() ? t : null;
                } catch (JavaModelException e) {
                    return null;
                }
            });
        }

        boolean present(String fqn) { return type(fqn) != null; }

        /** Boot's {@code WebApplicationType.deduceFromClasspath}. */
        String webType() {
            if (present("org.springframework.web.reactive.DispatcherHandler")
                    && !present("org.springframework.web.servlet.DispatcherServlet")
                    && !present("org.glassfish.jersey.servlet.ServletContainer")) return "reactive";
            boolean servlet = present("jakarta.servlet.Servlet") || present("javax.servlet.Servlet");
            if (!servlet || !present("org.springframework.web.context.ConfigurableWebApplicationContext")) return "none";
            return "servlet";
        }

        Map<String, Object> build(List<java.io.File> jars) throws Exception {
            // Registered auto-configurations, in classpath order, with the jar declaring them.
            Map<String, String> registered = new LinkedHashMap<>();
            for (java.io.File jar : jars) {
                check(monitor);
                try (ZipFile zip = new ZipFile(jar)) {
                    var imports = zip.getEntry(IMPORTS_FILE);
                    if (imports != null) {
                        try (var in = zip.getInputStream(imports)) {
                            for (String line : new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).split("\\R")) {
                                String fqn = line.replaceAll("#.*", "").trim();
                                if (!fqn.isEmpty()) registered.putIfAbsent(fqn, jar.getName());
                            }
                        }
                    }
                    var factories = zip.getEntry("META-INF/spring.factories");
                    if (factories != null) {
                        Properties p = new Properties();
                        try (var in = zip.getInputStream(factories)) { p.load(in); }
                        for (String fqn : p.getProperty(FACTORIES_KEY, "").split(",")) {
                            if (!fqn.isBlank()) registered.putIfAbsent(fqn.trim(), jar.getName());
                        }
                    }
                } catch (java.io.IOException e) {
                    incomplete = true;
                }
            }
            List<Map<String, Object>> configurations = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            Deque<Pending> queue = new ArrayDeque<>();
            registered.forEach((fqn, jar) -> queue.add(new Pending(fqn, jar, "autoConfiguration", List.of())));
            while (!queue.isEmpty()) {
                check(monitor);
                Pending next = queue.poll();
                if (!seen.add(next.fqn)) continue;
                if (configurations.size() >= MAX_CONFIGURATIONS) { incomplete = true; break; }
                IType t = type(next.fqn);
                if (t == null) continue;
                Map<String, Object> config = configuration(t, next, queue);
                if (config != null) configurations.add(config);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("project", project.getProject().getLocation() == null ? "" : project.getProject().getLocation().toOSString());
            out.put("web", web);
            out.put("configurations", configurations);
            out.put("types", supertypes);
            out.put("incomplete", incomplete);
            return out;
        }

        /** A configuration class, or null when a class condition rules it out. */
        /**
         * A configuration class, or null when a class condition rules it out. Its conditions
         * include those of the configuration importing or enclosing it, which Spring only
         * processes when that one is registered.
         */
        Map<String, Object> configuration(IType t, Pending from, Deque<Pending> queue) throws JavaModelException {
            String jar = from.jar, source = from.source;
            List<Map<String, Object>> conditions = new ArrayList<>(from.inherited);
            if (!conditions(t.getAnnotations(), conditions)) return null;
            List<String> before = new ArrayList<>(), after = new ArrayList<>();
            List<Map<String, Object>> beans = new ArrayList<>();
            for (IAnnotation a : t.getAnnotations()) {
                String name = a.getElementName();
                if (name.equals(AUTO_CONFIGURATION) || name.endsWith(".AutoConfigureBefore") || name.endsWith(".AutoConfigureAfter")) {
                    boolean isBefore = name.endsWith("Before");
                    for (IMemberValuePair p : a.getMemberValuePairs()) {
                        List<String> into = p.getMemberName().startsWith("before") || (isBefore && !p.getMemberName().startsWith("after"))
                                ? before : after;
                        into.addAll(strings(p.getValue()));
                    }
                } else if (name.equals(IMPORT)) {
                    for (IMemberValuePair p : a.getMemberValuePairs())
                        for (String c : strings(p.getValue())) queue.add(new Pending(resolve(t, c), jar, "import", conditions));
                } else if (name.equals(ENABLE_PROPERTIES)) {
                    for (IMemberValuePair p : a.getMemberValuePairs()) {
                        for (String c : strings(p.getValue())) {
                            String fqn = resolve(t, c);
                            IType props = type(fqn);
                            String prefix = "";
                            if (props != null) {
                                for (IAnnotation pa : props.getAnnotations()) {
                                    if (!pa.getElementName().equals(PROPERTIES)) continue;
                                    for (IMemberValuePair pp : pa.getMemberValuePairs())
                                        if (pp.getMemberName().equals("prefix") || pp.getMemberName().equals("value"))
                                            prefix = String.join("", strings(pp.getValue()));
                                }
                            }
                            Map<String, Object> bean = new LinkedHashMap<>();
                            // `EnableConfigurationPropertiesRegistrar`: named `prefix-FQN`.
                            bean.put("names", List.of(prefix.isEmpty() ? fqn : prefix + "-" + fqn));
                            bean.put("type", fqn);
                            bean.put("args", List.of());
                            bean.put("conditions", List.of());
                            bean.put("handle", props == null ? "" : props.getHandleIdentifier());
                            bean.put("member", "");
                            bean.put("primary", false);
                            bean.put("autowireCandidate", true);
                            bean.put("defaultCandidate", true);
                            hierarchy(fqn);
                            beans.add(bean);
                        }
                    }
                }
            }
            for (IMethod m : t.getMethods()) {
                IAnnotation bean = annotation(m, BEAN);
                if (bean == null) continue;
                List<Map<String, Object>> beanConditions = new ArrayList<>();
                if (!conditions(m.getAnnotations(), beanConditions)) continue;
                String returned = Signature.toString(Signature.getTypeErasure(m.getReturnType())).replace('/', '.');
                if (returned.equals("void")) continue;
                List<String> args = new ArrayList<>();
                for (String arg : Signature.getTypeArguments(m.getReturnType()))
                    args.add(Signature.toString(Signature.getTypeErasure(arg)).replace('/', '.'));
                List<String> names = new ArrayList<>();
                boolean autowire = true, defaults = true;
                for (IMemberValuePair p : bean.getMemberValuePairs()) {
                    switch (p.getMemberName()) {
                        case "name", "value" -> names.addAll(strings(p.getValue()));
                        case "autowireCandidate" -> autowire = !Boolean.FALSE.equals(p.getValue());
                        case "defaultCandidate" -> defaults = !Boolean.FALSE.equals(p.getValue());
                        default -> {}
                    }
                }
                if (names.isEmpty()) names.add(m.getElementName());
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("names", names);
                out.put("type", returned);
                out.put("args", args);
                out.put("conditions", beanConditions);
                out.put("handle", m.getHandleIdentifier());
                out.put("member", m.getElementName());
                out.put("primary", annotation(m, PRIMARY) != null);
                out.put("autowireCandidate", autowire);
                out.put("defaultCandidate", defaults);
                hierarchy(returned);
                beans.add(out);
            }
            // Member configuration classes are registered with their enclosing one.
            for (IType member : t.getTypes()) {
                if (annotation(member, CONFIGURATION) != null)
                    queue.add(new Pending(member.getFullyQualifiedName('$'), jar, "nested", conditions));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("fqn", t.getFullyQualifiedName('$'));
            out.put("handle", t.getHandleIdentifier());
            out.put("jar", jar);
            out.put("source", source);
            out.put("before", before);
            out.put("after", after);
            out.put("conditions", conditions);
            out.put("beans", beans);
            return out;
        }

        /**
         * Adds the conditions of {@code annotations} that the client decides to {@code out};
         * false when one decided here does not match.
         */
        boolean conditions(IAnnotation[] annotations, List<Map<String, Object>> out) throws JavaModelException {
            for (IAnnotation a : annotations) {
                String name = a.getElementName();
                boolean condition = name.startsWith(CONDITION_PACKAGE) || name.equals("org.springframework.context.annotation.Profile")
                        || name.equals("org.springframework.context.annotation.Conditional");
                if (!condition) continue;
                String kind = name.substring(name.lastIndexOf('.') + 1);
                Map<String, List<String>> attrs = new TreeMap<>();
                for (IMemberValuePair p : a.getMemberValuePairs()) attrs.put(p.getMemberName(), strings(p.getValue()));
                switch (kind) {
                    case "ConditionalOnClass" -> {
                        for (String c : classes(attrs)) if (!present(c)) return false;
                    }
                    case "ConditionalOnMissingClass" -> {
                        for (String c : classes(attrs)) if (present(c)) return false;
                    }
                    case "ConditionalOnWebApplication" -> {
                        String type = attrs.getOrDefault("type", List.of("ANY")).stream().findFirst().orElse("ANY");
                        type = type.substring(type.lastIndexOf('.') + 1);
                        boolean ok = switch (type) {
                            case "SERVLET" -> web.equals("servlet");
                            case "REACTIVE" -> web.equals("reactive");
                            default -> !web.equals("none");
                        };
                        if (!ok) return false;
                    }
                    case "ConditionalOnNotWebApplication" -> {
                        if (!web.equals("none")) return false;
                    }
                    // Boot's data source conditions decide by the classpath (and `spring.datasource.type`,
                    // which only adds pools): decided here as Spring Boot's IDE support does.
                    case "Conditional" -> {
                        List<String> value = attrs.getOrDefault("value", List.of());
                        boolean pooled = POOLS.stream().anyMatch(this::present);
                        if (value.stream().anyMatch(v -> v.endsWith("PooledDataSourceCondition"))) {
                            if (!pooled) return false;
                        } else if (value.stream().anyMatch(v -> v.endsWith("EmbeddedDatabaseCondition"))) {
                            if (pooled || EMBEDDED.stream().noneMatch(this::present)) return false;
                        } else {
                            out.add(Map.of("kind", kind, "attrs", attrs));
                        }
                    }
                    default -> out.add(Map.of("kind", kind, "attrs", attrs));
                }
            }
            return true;
        }

        static List<String> classes(Map<String, List<String>> attrs) {
            List<String> out = new ArrayList<>(attrs.getOrDefault("value", List.of()));
            out.addAll(attrs.getOrDefault("name", List.of()));
            return out;
        }

        /** Supertypes (FQNs) of a bean type, recorded once. */
        void hierarchy(String fqn) {
            if (supertypes.containsKey(fqn)) return;
            List<String> all = new ArrayList<>();
            supertypes.put(fqn, all);
            Deque<String> queue = new ArrayDeque<>(List.of(fqn));
            Set<String> seen = new HashSet<>(queue);
            while (!queue.isEmpty()) {
                IType t = type(queue.poll());
                if (t == null) continue;
                List<String> supers = new ArrayList<>();
                try {
                    if (t.getSuperclassName() != null) supers.add(resolve(t, t.getSuperclassName()));
                    for (String i : t.getSuperInterfaceNames()) supers.add(resolve(t, i));
                } catch (JavaModelException e) {
                    continue;
                }
                for (String s : supers) {
                    if (s.equals("java.lang.Object") || !seen.add(s)) continue;
                    all.add(s);
                    queue.add(s);
                }
            }
        }

        /** A type name of {@code context} as a FQN (binary types already are; generics dropped). */
        String resolve(IType context, String name) {
            String erased = name.replaceAll("<.*>", "");
            if (erased.contains(".") || context.isBinary()) return erased;
            try {
                String[][] r = context.resolveType(erased);
                if (r != null && r.length > 0) return r[0][0].isEmpty() ? r[0][1] : r[0][0] + "." + r[0][1];
            } catch (JavaModelException e) {
                // keep as written
            }
            return erased;
        }

        static IAnnotation annotation(IAnnotatable element, String fqn) throws JavaModelException {
            for (IAnnotation a : element.getAnnotations()) if (a.getElementName().equals(fqn)) return a;
            return null;
        }

        /** String / class / enum values of an annotation member (arrays flattened). */
        static List<String> strings(Object value) {
            List<String> out = new ArrayList<>();
            if (value instanceof Object[] array) {
                for (Object v : array) out.addAll(strings(v));
            } else if (value instanceof IAnnotation) {
                // nested annotations are not needed by the client
            } else if (value != null) {
                out.add(value.toString());
            }
            return out;
        }
    }
}
