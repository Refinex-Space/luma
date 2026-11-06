package com.example.demo;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class GreetingController {
    @Value("${app.greeting}")
    private String greeting;

    // Try with hot reload: change this text, add a field, a method or a new @GetMapping, then save.
    @GetMapping("/hello")
    public String hello() {
        return greeting + ", v1";
    }
}
