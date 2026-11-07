package fx;

@Tag(value = "shape", color = Color.RED, types = {String.class, int.class})
public sealed interface Shape permits Shape.Circle, Shape.Square {
    double area();
    default String describe() { return "shape"; }
    static Shape unit() { return new Circle(1); }
    record Circle(double r) implements Shape { public double area() { return r * r; } }
    final class Square implements Shape { public double area() { return 1; } }
}
