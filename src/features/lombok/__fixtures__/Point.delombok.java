package demo;

public final class Point {
    private final int x;
    private final int y;
    private final String label;

    public int sum() {
        return x + y;
    }

    @lombok.Generated
    public Point(final int x, final int y, final String label) {
        this.x = x;
        this.y = y;
        this.label = label;
    }

    @lombok.Generated
    public int getX() {
        return this.x;
    }

    @lombok.Generated
    public int getY() {
        return this.y;
    }

    @Override
    @lombok.Generated
    public boolean equals(final Object o) {
        if (o == this) return true;
        if (!(o instanceof Point)) return false;
        final Point other = (Point) o;
        if (this.getX() != other.getX()) return false;
        if (this.getY() != other.getY()) return false;
        final Object this$label = this.label;
        final Object other$label = other.label;
        if (this$label == null ? other$label != null : !this$label.equals(other$label)) return false;
        return true;
    }

    @Override
    @lombok.Generated
    public int hashCode() {
        final int PRIME = 59;
        int result = 1;
        result = result * PRIME + this.getX();
        result = result * PRIME + this.getY();
        final Object $label = this.label;
        result = result * PRIME + ($label == null ? 43 : $label.hashCode());
        return result;
    }

    @Override
    @lombok.Generated
    public String toString() {
        return "Point(x=" + this.getX() + ", y=" + this.getY() + ", label=" + this.label + ")";
    }
}
