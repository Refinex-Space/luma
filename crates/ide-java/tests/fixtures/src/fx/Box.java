package fx;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/** Generic class with bounds, inner classes, varargs, constants. */
public class Box<T extends Comparable<? super T>> implements Iterable<T> {
    public static final String NAME = "box";
    public static final int SIZE = 42;
    protected List<? extends T> items;
    Map<String, List<T>> index;

    public Box(List<? extends T> items) { this.items = items; }

    public <R> R map(java.util.function.Function<? super T, ? extends R> f) throws IOException { return null; }

    public static <E extends Number & Comparable<E>> E max(E... values) { return values[0]; }

    @Deprecated
    public void old() {}

    public java.util.Iterator<T> iterator() { return null; }

    /** Non-static inner class: its constructor gets the outer instance from the compiler. */
    public class Cursor {
        public Cursor(int start) {}
        public T current() { return null; }
    }

    public static class Entry<K, V> {
        public K key;
        public V value;
    }

    public Object anon() {
        return new Runnable() { public void run() {} };
    }
}
