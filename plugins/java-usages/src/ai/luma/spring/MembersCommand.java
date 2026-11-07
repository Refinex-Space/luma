package ai.luma.spring;

import java.util.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;

/**
 * The public members of a type, for SpEL completion and navigation (Luma's Spring plugin).
 *
 * <p>{@code luma.spring.members [uri, fqn]}: in the Java project of {@code uri}, the type
 * {@code fqn} (source or library) with its JDT handle, and the public methods and fields it
 * declares or inherits (overridden ones once): name, static, parameter types (simple), the
 * erased qualified return / field type, the declaring type and the member's handle.
 * {@code null} when the type is unknown.
 */
public final class MembersCommand implements IDelegateCommandHandler {
    private static final int MAX_MEMBERS = 600;

    @Override
    public Object executeCommand(String command, List<Object> args, IProgressMonitor monitor) throws Exception {
        IJavaProject project = LibraryCommand.project((String) args.get(0));
        String fqn = (String) args.get(1);
        if (project == null || fqn == null || fqn.isBlank()) return null;
        IType type = project.findType(fqn.replace('$', '.'));
        if (type == null || !type.exists()) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("fqn", type.getFullyQualifiedName('.'));
        out.put("handle", type.getHandleIdentifier());
        out.put("interface", type.isInterface());
        List<Map<String, Object>> members = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        List<IType> chain = new ArrayList<>();
        chain.add(type);
        ITypeHierarchy hierarchy = type.newSupertypeHierarchy(monitor);
        chain.addAll(Arrays.asList(hierarchy.getAllSupertypes(type)));
        for (IType t : chain) {
            if (monitor.isCanceled() || members.size() >= MAX_MEMBERS) break;
            boolean iface = t.isInterface();
            for (IMethod m : t.getMethods()) {
                int flags = m.getFlags();
                if (m.isConstructor() || m.getElementName().startsWith("<")) continue;
                if (!iface && !Flags.isPublic(flags)) continue;
                String[] params = m.getParameterTypes();
                String key = m.getElementName() + "/" + params.length + "/" + String.join(",", params);
                if (!seen.add(key)) continue;
                Map<String, Object> e = new LinkedHashMap<>();
                e.put("name", m.getElementName());
                e.put("kind", "method");
                e.put("static", Flags.isStatic(flags));
                List<String> simple = new ArrayList<>();
                for (String p : params) simple.add(Signature.getSimpleName(Signature.toString(Signature.getTypeErasure(p))));
                e.put("params", simple);
                e.put("paramNames", Arrays.asList(m.getParameterNames()));
                e.put("returns", resolve(t, m.getReturnType()));
                e.put("declaring", t.getFullyQualifiedName('.'));
                e.put("handle", m.getHandleIdentifier());
                members.add(e);
            }
            for (IField f : t.getFields()) {
                int flags = f.getFlags();
                if (!iface && !Flags.isPublic(flags)) continue;
                if (!seen.add("field/" + f.getElementName())) continue;
                Map<String, Object> e = new LinkedHashMap<>();
                e.put("name", f.getElementName());
                e.put("kind", "field");
                e.put("static", Flags.isStatic(flags) || iface);
                e.put("params", List.of());
                e.put("paramNames", List.of());
                e.put("returns", resolve(t, f.getTypeSignature()));
                e.put("declaring", t.getFullyQualifiedName('.'));
                e.put("handle", f.getHandleIdentifier());
                members.add(e);
            }
        }
        out.put("members", members);
        return out;
    }

    /** The erased, qualified type of a signature as seen from `in` (`String` → `java.lang.String`). */
    private static String resolve(IType in, String signature) {
        String erased = Signature.getTypeErasure(signature);
        int dims = Signature.getArrayCount(erased);
        String element = Signature.getElementType(erased);
        String name = Signature.toString(element);
        if (element.charAt(0) == Signature.C_UNRESOLVED) {
            try {
                String[][] found = in.resolveType(name);
                if (found != null && found.length > 0) {
                    name = found[0][0].isEmpty() ? found[0][1] : found[0][0] + "." + found[0][1];
                }
            } catch (JavaModelException e) {
                // As written.
            }
        }
        return name + "[]".repeat(dims);
    }
}
