package ai.luma.usages;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.IBuffer;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IField;
import org.eclipse.jdt.core.IJavaElement;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.ITypeRoot;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.search.IJavaSearchConstants;
import org.eclipse.jdt.core.search.IJavaSearchScope;
import org.eclipse.jdt.core.search.SearchEngine;
import org.eclipse.jdt.core.search.SearchMatch;
import org.eclipse.jdt.core.search.SearchParticipant;
import org.eclipse.jdt.core.search.SearchPattern;
import org.eclipse.jdt.core.search.SearchRequestor;
import org.eclipse.jdt.internal.corext.codemanipulation.GetterSetterUtil;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.handlers.ReferencesHandler;

/**
 * Usage counts of several declarations of one file, per referencing file (IDEA's usages inlay).
 *
 * <p>Arguments: the declaring file's URI and the targets, {@code [{line, character, files?}]}.
 * Without {@code files} a target is counted over every source folder of the workspace; with them,
 * only in those files (the caller recounts the files that changed since its last count).
 * Returns per target {@code {resolved, files: {uri: count}}}; with explicit files every one of them
 * is listed, with 0 when it has no usage.
 *
 * <p>Counts what {@code luma.java.usages} lists (the same search targets: a field with its
 * getter, setter, builder and Lombok accessors) without classifying each usage. Libraries are not
 * searched: they cannot refer to project sources. Targets whose search names are unique are
 * searched together in one OR pattern, so each candidate file is parsed and resolved once; every
 * match is credited to the one target its identifier names.
 */
public final class UsageCountsCommand implements IDelegateCommandHandler {
    private static final Pattern IDENTIFIER = Pattern.compile("[\\p{L}_$][\\p{L}\\p{N}_$]*");

    private static final class Target {
        boolean resolved;
        final Set<IJavaElement> elements = new LinkedHashSet<>();
        /** Null: every source file. */
        Map<ICompilationUnit, String> files;
        /** Requested files JDT does not know (deleted, outside source folders): no usages. */
        final List<String> missing = new ArrayList<>();
        final Map<ICompilationUnit, Set<Long>> matches = new HashMap<>();
    }

    /** Matches of one search element: per file, `offset << 32 | length`. */
    private static final class Found extends HashMap<ICompilationUnit, Set<Long>> {
        private static final long serialVersionUID = 1L;

        void add(ICompilationUnit unit, int offset, int length) {
            computeIfAbsent(unit, u -> new HashSet<>()).add(((long) offset << 32) | (length & 0xffffffffL));
        }
    }

    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        String uri = (String) arguments.get(0);
        List<?> requests = (List<?>) arguments.get(1);
        var preferences = JavaLanguageServerPlugin.getPreferencesManager();
        boolean accessors = preferences.getPreferences().isIncludeAccessors();
        var handler = new ReferencesHandler(preferences);
        ITypeRoot root = JDTUtils.resolveTypeRoot(uri);
        List<Target> targets = new ArrayList<>();
        for (Object request : requests) {
            Map<?, ?> r = (Map<?, ?>) request;
            Target target = new Target();
            targets.add(target);
            if (root == null) continue;
            int line = ((Number) r.get("line")).intValue();
            int column = ((Number) r.get("character")).intValue();
            IJavaElement selected = JDTUtils.findElementAtSelection(root, line, column, preferences, monitor);
            checkCanceled(monitor);
            if (selected == null) continue;
            target.resolved = true;
            target.elements.addAll(plan(handler, selected, accessors));
            if (r.get("files") instanceof List<?> files) {
                target.files = new LinkedHashMap<>();
                for (Object file : files) {
                    ICompilationUnit unit = JDTUtils.resolveCompilationUnit((String) file);
                    // The caller recounts a file because it changed: see its content on disk
                    // (open files are working copies, their text is the editor's).
                    if (unit != null && !unit.isWorkingCopy() && unit.getResource() != null) {
                        unit.getResource().refreshLocal(IResource.DEPTH_ZERO, monitor);
                    }
                    if (unit != null && unit.exists()) target.files.put(unit, (String) file);
                    else target.missing.add((String) file);
                }
            }
        }

        // Each search element once, with the files of every target that searches it.
        Map<IJavaElement, List<Target>> owners = new LinkedHashMap<>();
        for (Target t : targets) for (IJavaElement e : t.elements) owners.computeIfAbsent(e, k -> new ArrayList<>()).add(t);
        List<IJavaElement> everywhere = new ArrayList<>();
        List<IJavaElement> scoped = new ArrayList<>();
        Set<ICompilationUnit> scopedFiles = new LinkedHashSet<>();
        owners.forEach((element, ts) -> {
            if (ts.stream().anyMatch(t -> t.files == null)) everywhere.add(element);
            else {
                scoped.add(element);
                ts.forEach(t -> scopedFiles.addAll(t.files.keySet()));
            }
        });
        Map<IJavaElement, Found> found = new HashMap<>();
        if (!everywhere.isEmpty()) found.putAll(searchAll(everywhere, sourcesScope(), monitor));
        if (!scoped.isEmpty() && !scopedFiles.isEmpty()) {
            IJavaSearchScope scope = SearchEngine.createJavaSearchScope(scopedFiles.toArray(new IJavaElement[0]));
            found.putAll(searchAll(scoped, scope, monitor));
        }
        owners.forEach((element, ts) -> {
            Found matches = found.get(element);
            if (matches == null) return;
            for (Target t : ts) matches.forEach((unit, keys) -> {
                if (t.files == null || t.files.containsKey(unit)) t.matches.computeIfAbsent(unit, u -> new HashSet<>()).addAll(keys);
            });
        });

        List<Map<String, Object>> response = new ArrayList<>();
        for (Target t : targets) {
            Map<String, Integer> files = new LinkedHashMap<>();
            if (t.files != null) {
                t.files.values().forEach(file -> files.put(file, 0));
                t.missing.forEach(file -> files.put(file, 0));
            }
            t.matches.forEach((unit, keys) -> {
                String file = t.files != null ? t.files.get(unit) : JDTUtils.toURI(unit);
                if (file != null && !keys.isEmpty()) files.put(file, keys.size());
            });
            response.add(Map.of("resolved", t.resolved, "files", files));
        }
        return response;
    }

    /** What a usage search of `selected` looks for, as {@link UsagesCommand} does. */
    private static Collection<IJavaElement> plan(ReferencesHandler handler, IJavaElement selected, boolean accessors) throws Exception {
        var plan = new UsagesCommand.SearchPlan();
        plan.add(selected, "unknown", false);
        if (accessors && selected instanceof IField field) {
            plan.add(GetterSetterUtil.getGetter(field), "getter", false);
            plan.add(GetterSetterUtil.getSetter(field), "setter", false);
            try {
                UsagesCommand.addNativeBuilderTargets(handler, field, plan);
            } catch (ReflectiveOperationException e) {
                // Another server version: builder setters are not counted.
            }
            UsagesCommand.addConfiguredAccessors(field, plan);
        }
        return plan.targets.keySet();
    }

    /** Source folders of every Java project: what project code can be referenced from. */
    private static IJavaSearchScope sourcesScope() throws CoreException {
        IJavaProject[] projects = JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects();
        return SearchEngine.createJavaSearchScope(projects, IJavaSearchScope.SOURCES);
    }

    /**
     * Searches `elements` in `scope`: the ones with a name no other element has in one OR pattern,
     * each other one alone.
     */
    private static Map<IJavaElement, Found> searchAll(List<IJavaElement> elements, IJavaSearchScope scope, IProgressMonitor monitor) throws CoreException {
        Map<String, List<IJavaElement>> byName = new LinkedHashMap<>();
        for (IJavaElement e : elements) byName.computeIfAbsent(e.getElementName(), k -> new ArrayList<>()).add(e);
        Map<String, IJavaElement> unique = new LinkedHashMap<>();
        List<IJavaElement> alone = new ArrayList<>();
        byName.forEach((name, list) -> {
            if (list.size() == 1) unique.put(name, list.get(0));
            else alone.addAll(list);
        });
        Map<IJavaElement, Found> out = new HashMap<>();
        if (unique.size() == 1) alone.addAll(unique.values());
        else if (!unique.isEmpty()) {
            Map<IJavaElement, Found> together = searchTogether(unique, scope, monitor);
            if (together != null) out.putAll(together);
            else alone.addAll(unique.values());
        }
        for (IJavaElement e : alone) {
            checkCanceled(monitor);
            Found f = new Found();
            search(SearchPattern.createPattern(e, IJavaSearchConstants.REFERENCES), scope, monitor,
                (match, unit) -> f.add(unit, match.getOffset(), match.getLength()));
            out.put(e, f);
        }
        return out;
    }

    /** One OR search; null when a match cannot be credited to exactly one element. */
    private static Map<IJavaElement, Found> searchTogether(Map<String, IJavaElement> byName, IJavaSearchScope scope, IProgressMonitor monitor) throws CoreException {
        SearchPattern pattern = null;
        Map<IJavaElement, Found> out = new HashMap<>();
        for (IJavaElement e : byName.values()) {
            SearchPattern p = SearchPattern.createPattern(e, IJavaSearchConstants.REFERENCES);
            if (p == null) continue;
            pattern = pattern == null ? p : SearchPattern.createOrPattern(pattern, p);
            out.put(e, new Found());
        }
        if (pattern == null) return out;
        boolean[] unattributed = { false };
        Map<ICompilationUnit, String> texts = new HashMap<>();
        search(pattern, scope, monitor, (match, unit) -> {
            String text = texts.computeIfAbsent(unit, UsageCountsCommand::contents);
            IJavaElement owner = text == null ? null : credited(byName, text, match.getOffset(), match.getLength());
            if (owner == null || !out.containsKey(owner)) unattributed[0] = true;
            else out.get(owner).add(unit, match.getOffset(), match.getLength());
        });
        return unattributed[0] ? null : out;
    }

    /**
     * The element a match names: the last identifier before any argument list (`foo` in
     * `this.foo(a)`, `a.b.Foo`, `Foo::foo`, `new Foo(`), when it is one of the searched names.
     */
    static IJavaElement credited(Map<String, IJavaElement> byName, String text, int offset, int length) {
        if (offset < 0 || length < 0 || offset + length > text.length()) return null;
        String matched = text.substring(offset, offset + length);
        int paren = matched.indexOf('(');
        if (paren >= 0) matched = matched.substring(0, paren);
        IJavaElement owner = null;
        Matcher m = IDENTIFIER.matcher(matched);
        while (m.find()) {
            IJavaElement e = byName.get(m.group());
            if (e != null) owner = e;
        }
        return owner;
    }

    private static String contents(ICompilationUnit unit) {
        try {
            IBuffer buffer = unit.getBuffer();
            return buffer == null ? null : buffer.getContents();
        } catch (CoreException e) {
            return null;
        }
    }

    private interface Accept {
        void accept(SearchMatch match, ICompilationUnit unit);
    }

    /** Accurate matches in source files, as `ReferencesHandler` keeps them. */
    private static void search(SearchPattern pattern, IJavaSearchScope scope, IProgressMonitor monitor, Accept accept) throws CoreException {
        if (pattern == null) return;
        new SearchEngine().search(pattern, new SearchParticipant[] { SearchEngine.getDefaultSearchParticipant() }, scope,
            new SearchRequestor() {
                @Override
                public void acceptSearchMatch(SearchMatch match) {
                    if (match.getAccuracy() == SearchMatch.A_INACCURATE) return;
                    if (!(match.getElement() instanceof IJavaElement element)) return;
                    if (element.getAncestor(IJavaElement.COMPILATION_UNIT) instanceof ICompilationUnit unit) {
                        // Matches are reported on working copies of open files; count them as the file.
                        accept.accept(match, unit.getPrimary());
                    }
                }
            }, monitor);
        checkCanceled(monitor);
    }

    private static void checkCanceled(IProgressMonitor monitor) {
        if (monitor != null && monitor.isCanceled()) throw new OperationCanceledException();
    }
}
