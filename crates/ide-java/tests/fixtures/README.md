Class files compiled from `src/fx` for the class-file stub tests:

```sh
javac --release 17 -parameters -d out src/fx/*.java && cp out/fx/*.class .
```
