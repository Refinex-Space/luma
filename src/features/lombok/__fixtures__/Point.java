package demo;

import lombok.Getter;
import lombok.Value;

@Value
public class Point {
    int x;
    int y;
    @Getter(lombok.AccessLevel.NONE) String label;

    public int sum() {
        return x + y;
    }
}
