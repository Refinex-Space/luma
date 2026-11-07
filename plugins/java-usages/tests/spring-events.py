"""Real JDT LS check of `luma.spring.events` against real Spring Framework jars from the local
Maven repository (7.0.10): publishEvent calls on an ApplicationEventPublisher and an
ApplicationContext, their event types and supertypes, an unsaved edit seen, warm timing.
Run with Java 21+ on PATH: python3 spring-events.py /path/to/jdtls
"""
import json
import os
import pathlib
import platform
import queue
import subprocess
import sys
import tempfile
import threading
import time

home = pathlib.Path(sys.argv[1]).resolve()
bundle = pathlib.Path(__file__).resolve().parents[1] / 'luma-java-usages.jar'
m2 = pathlib.Path(os.environ.get('LUMA_M2', pathlib.Path.home() / '.m2/repository'))
BOOT, SPRING = '4.1.2', '7.0.10'
coordinates = [
    ('org/springframework', 'spring-core', SPRING),
    ('org/springframework', 'spring-beans', SPRING),
    ('org/springframework', 'spring-context', SPRING),
]
jars = []
for group, artifact, version in coordinates:
    jar = m2 / group / artifact / version / f'{artifact}-{version}.jar'
    if jar.exists():
        jars.append(jar)
    else:
        print(f'skip (not in the local repository): {artifact}-{version}')
work = pathlib.Path(tempfile.mkdtemp(prefix='luma-spring-'))
project = work / 'project'
source_dir = project / 'src'
(source_dir / 'demo').mkdir(parents=True)
(source_dir / 'demo/OrderPlaced.java').write_text('package demo;\npublic class OrderPlaced extends org.springframework.context.ApplicationEvent {\n  public OrderPlaced(Object s) { super(s); }\n}\n')
source = """package demo;
import org.springframework.context.*;
public class Orders {
  private final ApplicationEventPublisher publisher;
  private final ApplicationContext context;
  Orders(ApplicationEventPublisher p, ApplicationContext c) { publisher = p; context = c; }
  void place() {
    publisher.publishEvent(new OrderPlaced(this));
  }
  static class Inner {
    void run(ApplicationContext c) { Runnable r = () -> c.publishEvent("payload"); }
  }
}
"""
file = source_dir / 'demo/Orders.java'
file.write_text(source)
(project / '.project').write_text('<projectDescription><name>spring</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
libs = ''.join(f'<classpathentry kind="lib" path="{jar}"/>' for jar in jars)
(project / '.classpath').write_text(f'<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>{libs}<classpathentry kind="output" path="bin"/></classpath>')
config = work / 'config'
config.mkdir()
name = {'Darwin': 'config_mac', 'Windows': 'config_win'}.get(platform.system(), 'config_linux')
names = ([name + '_arm'] if platform.machine().lower() in ('arm64', 'aarch64') else []) + [name]
(config / 'config.ini').write_bytes(next(home / n / 'config.ini' for n in names if (home / n / 'config.ini').exists()).read_bytes())
log = (work / 'stderr.log').open('w')
proc = subprocess.Popen(['java', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', str(next((home / 'plugins').glob('org.eclipse.equinox.launcher_*.jar'))), '-configuration', str(config), '-data', str(work / 'metadata')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
messages = queue.Queue()
lock = threading.Lock()
def send(message):
    data = json.dumps(message).encode()
    with lock:
        proc.stdin.write(f'Content-Length: {len(data)}\r\n\r\n'.encode() + data)
        proc.stdin.flush()
def read():
    while True:
        headers = {}
        while True:
            line = proc.stdout.readline()
            if not line: return
            if line == b'\r\n': break
            k, v = line.decode().split(':', 1)
            headers[k.lower()] = v.strip()
        message = json.loads(proc.stdout.read(int(headers['content-length'])))
        if 'method' in message and 'id' in message:
            send({'jsonrpc': '2.0', 'id': message['id'], 'result': [] if message['method'] == 'workspace/configuration' else None})
        else: messages.put(message)
threading.Thread(target=read, daemon=True).start()
sequence = 0
transcript = []
def request(method, params):
    global sequence
    sequence += 1
    send({'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        msg = messages.get(timeout=max(1, deadline - time.monotonic()))
        transcript.append(msg)
        if msg.get('id') == sequence:
            if 'error' in msg: raise RuntimeError(msg['error'])
            return msg.get('result')
    raise TimeoutError(method)
try:
    init = request('initialize', {'processId': None, 'rootUri': project.as_uri(), 'workspaceFolders': [{'uri': project.as_uri(), 'name': 'spring'}], 'capabilities': {}, 'initializationOptions': {'bundles': [str(bundle)], 'settings': {'java': {'import': {'gradle': {'enabled': False}, 'maven': {'enabled': False}}}}}})
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
    send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': file.as_uri(), 'languageId': 'java', 'version': 1, 'text': source}}})
    request('java/buildWorkspace', True)
    assert 'luma.spring.events' in init['capabilities']['executeCommandProvider']['commands']
    def events():
        start = time.perf_counter()
        result = request('workspace/executeCommand', {'command': 'luma.spring.events', 'arguments': [file.as_uri()]})
        return result, time.perf_counter() - start
    result, cold = events()
    calls = sorted(result['publishers'], key=lambda c: c['line'])
    assert [(c['line'], c['col'], c['event'], c['method']) for c in calls] == [
        (7, source.splitlines()[7].index('publishEvent'), 'demo.OrderPlaced', 'Orders.place()'),
        (10, source.splitlines()[10].index('publishEvent'), 'java.lang.String', 'Orders.Inner.run()'),
    ], calls
    assert 'org.springframework.context.ApplicationEvent' in calls[0]['supertypes'] and 'java.util.EventObject' in calls[0]['supertypes'], calls[0]
    assert 'java.lang.Object' not in calls[0]['supertypes']
    _, warm = events()
    # An unsaved edit: a new call is seen from the working copy.
    edited = source.replace('  void place() {\n', '  void place() {\n    context.publishEvent(new OrderPlaced(1));\n')
    send({'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {'textDocument': {'uri': file.as_uri(), 'version': 2}, 'contentChanges': [{'text': edited}]}})
    time.sleep(1.5)
    after, _ = events()
    lines = sorted(c['line'] for c in after['publishers'])
    assert lines == [7, 8, 11], after
    assert warm < 0.5, warm
    print('ok:', json.dumps({'cold_s': round(cold, 2), 'warm_ms': round(warm * 1000), 'calls': len(calls)}))
finally:
    try:
        send({'jsonrpc': '2.0', 'id': 99999, 'method': 'shutdown', 'params': None})
        send({'jsonrpc': '2.0', 'method': 'exit', 'params': None})
    except Exception:
        pass
    proc.kill()
