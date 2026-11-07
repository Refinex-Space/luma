package ai.luma.spring;

import java.util.*;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.core.search.*;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;

/**
 * Where application events are published (Luma's Spring model, IDEA's event publisher markers).
 *
 * <p>{@code luma.spring.events [uri]}: every {@code publishEvent(…)} call of the workspace's
 * sources on an {@code ApplicationEventPublisher} (an {@code ApplicationContext} is one), with
 * the published object's type and its supertypes as the compiler resolves them, and the method
 * making the call. The calls are found with the search engine (its index); each file is parsed
 * with bindings only when its contents changed since the last answer.
 */
public final class EventsCommand implements IDelegateCommandHandler {
    private static final String PUBLISHER = "org.springframework.context.ApplicationEventPublisher";
    private static final int MAX_CALLS = 5000;
    /** Per compilation unit: the contents its calls were read from, and the calls. */
    private static final Map<String, Unit> UNITS = new HashMap<>();

    private record Unit(String source, List<Map<String, Object>> calls) {}

    @Override
    public Object executeCommand(String command, List<Object> args, IProgressMonitor monitor) throws Exception {
        IJavaProject project = LibraryCommand.project((String) args.get(0));
        IType publisher = project == null ? null : project.findType(PUBLISHER);
        if (publisher == null || !publisher.exists()) return Map.of("publishers", List.of(), "incomplete", project == null);
        return publishers(publisher, monitor);
    }

    private static synchronized Map<String, Object> publishers(IType publisher, IProgressMonitor monitor) throws CoreException {
        SearchPattern pattern = null;
        for (IMethod m : publisher.getMethods()) {
            if (!m.getElementName().equals("publishEvent")) continue;
            SearchPattern p = SearchPattern.createPattern(m, IJavaSearchConstants.REFERENCES);
            pattern = pattern == null ? p : SearchPattern.createOrPattern(pattern, p);
        }
        if (pattern == null) return Map.of("publishers", List.of(), "incomplete", false);
        IJavaProject[] projects = JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects();
        IJavaSearchScope scope = SearchEngine.createJavaSearchScope(projects, IJavaSearchScope.SOURCES);
        Map<ICompilationUnit, List<Integer>> offsets = new LinkedHashMap<>();
        new SearchEngine().search(pattern, new SearchParticipant[] { SearchEngine.getDefaultSearchParticipant() }, scope,
            new SearchRequestor() {
                @Override
                public void acceptSearchMatch(SearchMatch match) {
                    if (match.getAccuracy() == SearchMatch.A_INACCURATE) return;
                    if (match.getElement() instanceof IJavaElement e
                            && e.getAncestor(IJavaElement.COMPILATION_UNIT) instanceof ICompilationUnit unit) {
                        offsets.computeIfAbsent(unit.getPrimary(), u -> new ArrayList<>()).add(match.getOffset());
                    }
                }
            }, monitor);
        if (monitor.isCanceled()) throw new OperationCanceledException();

        List<Map<String, Object>> out = new ArrayList<>();
        Set<String> live = new HashSet<>();
        boolean incomplete = false;
        for (var entry : offsets.entrySet()) {
            ICompilationUnit unit = entry.getKey();
            String key = unit.getHandleIdentifier();
            live.add(key);
            String source = unit.getSource();
            Unit cached = UNITS.get(key);
            if (cached == null || !cached.source.equals(source)) {
                cached = new Unit(source, read(unit, entry.getValue(), monitor));
                UNITS.put(key, cached);
            }
            out.addAll(cached.calls);
            if (out.size() > MAX_CALLS) {
                incomplete = true;
                break;
            }
        }
        UNITS.keySet().retainAll(live);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("publishers", out);
        result.put("incomplete", incomplete);
        return result;
    }

    /** The calls at `offsets` (where `publishEvent` is) of one file, its types resolved. */
    private static List<Map<String, Object>> read(ICompilationUnit unit, List<Integer> offsets, IProgressMonitor monitor) {
        ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
        parser.setSource(unit);
        parser.setResolveBindings(true);
        parser.setBindingsRecovery(true);
        CompilationUnit tree = (CompilationUnit) parser.createAST(monitor);
        String uri = JDTUtils.toURI(unit);
        List<Map<String, Object>> calls = new ArrayList<>();
        for (int offset : offsets) {
            ASTNode node = NodeFinder.perform(tree, offset, "publishEvent".length());
            MethodInvocation call = null;
            for (ASTNode n = node; n != null; n = n.getParent()) {
                if (n instanceof MethodInvocation m && m.getName().getStartPosition() == offset) {
                    call = m;
                    break;
                }
            }
            if (call == null || call.arguments().isEmpty()) continue;
            ITypeBinding type = ((Expression) call.arguments().get(0)).resolveTypeBinding();
            if (type == null || type.isRecovered()) continue;
            type = type.getErasure();
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("uri", uri);
            c.put("line", tree.getLineNumber(offset) - 1);
            c.put("col", tree.getColumnNumber(offset));
            c.put("len", "publishEvent".length());
            c.put("event", name(type));
            c.put("supertypes", supertypes(type));
            c.put("method", enclosing(call));
            calls.add(c);
        }
        return calls;
    }

    private static String name(ITypeBinding t) {
        return t.isPrimitive() ? t.getName() : t.getErasure().getQualifiedName();
    }

    /** Every supertype (erased, qualified), `Object` aside. */
    private static List<String> supertypes(ITypeBinding type) {
        Set<String> out = new LinkedHashSet<>();
        Deque<ITypeBinding> queue = new ArrayDeque<>();
        queue.add(type);
        while (!queue.isEmpty()) {
            ITypeBinding t = queue.poll();
            List<ITypeBinding> supers = new ArrayList<>();
            if (t.getSuperclass() != null) supers.add(t.getSuperclass());
            supers.addAll(Arrays.asList(t.getInterfaces()));
            for (ITypeBinding s : supers) {
                String n = name(s.getErasure());
                if (!n.equals("java.lang.Object") && out.add(n)) queue.add(s.getErasure());
            }
        }
        return new ArrayList<>(out);
    }

    /** `OrderService.place()`, `Outer.Inner.run()`, or the type for initializers. */
    private static String enclosing(ASTNode n) {
        String method = null;
        for (ASTNode p = n; p != null; p = p.getParent()) {
            if (method == null && p instanceof MethodDeclaration m) method = m.getName().getIdentifier();
            if (p instanceof AbstractTypeDeclaration t) {
                StringBuilder type = new StringBuilder(t.getName().getIdentifier());
                for (ASTNode o = t.getParent(); o != null; o = o.getParent()) {
                    if (o instanceof AbstractTypeDeclaration outer) type.insert(0, outer.getName().getIdentifier() + ".");
                }
                return method == null ? type.toString() : type + "." + method + "()";
            }
        }
        return method == null ? "" : method + "()";
    }
}
