"""Real JDT LS check of `luma.spring.library` / `luma.spring.locate` against real Spring Boot
jars from the local Maven repository (Boot 4.1.2, Spring Framework 7.0.10), with cold and warm
timings. Run with Java 21+ on PATH: python3 spring-library.py /path/to/jdtls
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
    ('org/springframework/boot', 'spring-boot', BOOT),
    ('org/springframework/boot', 'spring-boot-autoconfigure', BOOT),
    ('org/springframework/boot', 'spring-boot-jdbc', BOOT),
    ('org/springframework/boot', 'spring-boot-jackson', BOOT),
    ('org/springframework/boot', 'spring-boot-sql', BOOT),
    ('org/springframework', 'spring-core', SPRING),
    ('org/springframework', 'spring-beans', SPRING),
    ('org/springframework', 'spring-context', SPRING),
    ('org/springframework', 'spring-jdbc', SPRING),
    ('org/springframework', 'spring-tx', SPRING),
    ('org/springframework', 'spring-web', SPRING),
    ('org/springframework', 'spring-webmvc', SPRING),
    ('com/zaxxer', 'HikariCP', '7.0.2'),
    ('tools/jackson/core', 'jackson-databind', '3.1.7'),
    ('tools/jackson/core', 'jackson-core', '3.1.7'),
    ('jakarta/servlet', 'jakarta.servlet-api', '6.1.0'),
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
source = 'package demo;\npublic class App {}\n'
file = source_dir / 'demo/App.java'
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
    init = request('initialize', {'processId': None, 'rootUri': project.as_uri(), 'workspaceFolders': [{'uri': project.as_uri(), 'name': 'spring'}], 'capabilities': {}, 'initializationOptions': {'bundles': [str(bundle)], 'extendedClientCapabilities': {'classFileContentsSupport': True}, 'settings': {'java': {'import': {'gradle': {'enabled': False}, 'maven': {'enabled': False}}}}}})
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
    send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': file.as_uri(), 'languageId': 'java', 'version': 1, 'text': source}}})
    request('java/buildWorkspace', True)
    commands = init['capabilities']['executeCommandProvider']['commands']
    assert 'luma.spring.library' in commands and 'luma.spring.locate' in commands, commands
    def library():
        start = time.perf_counter()
        result = request('workspace/executeCommand', {'command': 'luma.spring.library', 'arguments': [file.as_uri()]})
        return result, time.perf_counter() - start
    result, cold = library()
    _, warm = library()
    configs = result['configurations']
    beans = [b for c in configs for b in c['beans']]
    fqns = {c['fqn'] for c in configs}
    print(f'cold {cold:.2f}s, warm {warm * 1000:.0f}ms: {len(configs)} configurations, {len(beans)} beans, web={result["web"]}, incomplete={result["incomplete"]}')
    assert result['web'] == 'servlet', result['web']
    assert 'org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration' in fqns, sorted(fqns)[:20]
    # Hikari is on the classpath: its pooled data source configuration is in, the others are ruled out by class conditions.
    assert any(f.endswith('DataSourceConfiguration$Hikari') for f in fqns), [f for f in fqns if 'DataSource' in f]
    assert not any(f.endswith('DataSourceConfiguration$OracleUcp') for f in fqns)
    # A pool is on the classpath: the embedded database configuration (imported under
    # `EmbeddedDatabaseCondition`) is out; Hikari's inherits its importer's `@ConditionalOnMissingBean`.
    assert not any(c['fqn'].endswith('EmbeddedDataSourceConfiguration') for c in configs), [c['fqn'] for c in configs if 'Embedded' in c['fqn']]
    hikari_config = next(c for c in configs if c['fqn'].endswith('DataSourceConfiguration$Hikari'))
    assert sum(c['kind'] == 'ConditionalOnMissingBean' for c in hikari_config['conditions']) >= 1, hikari_config['conditions']
    hikari = [b for b in beans if b['type'] == 'com.zaxxer.hikari.HikariDataSource']
    assert hikari and 'dataSource' in hikari[0]['names'], hikari
    kinds = {c['kind'] for c in hikari[0]['conditions']}
    assert 'ConditionalOnMissingBean' in kinds or any(c['kind'] == 'ConditionalOnMissingBean' for cfg in configs if cfg['fqn'].endswith('$Hikari') for c in cfg['conditions']), hikari[0]
    assert 'javax.sql.DataSource' in result['types']['com.zaxxer.hikari.HikariDataSource'], result['types']['com.zaxxer.hikari.HikariDataSource']
    assert any(b['type'] == 'tools.jackson.databind.json.JsonMapper' for b in beans), sorted({b['type'] for b in beans if 'jackson' in b['type']})
    properties = [b for b in beans if b['type'] == 'org.springframework.boot.jdbc.autoconfigure.DataSourceProperties']
    assert properties and properties[0]['names'][0] == 'spring.datasource-org.springframework.boot.jdbc.autoconfigure.DataSourceProperties', properties
    location = request('workspace/executeCommand', {'command': 'luma.spring.locate', 'arguments': [hikari[0]['handle']]})
    assert location and location['uri'].startswith('jdt://'), location
    assert warm < 0.5, warm
    print('ok:', json.dumps({'cold_s': round(cold, 2), 'warm_ms': round(warm * 1000), 'configurations': len(configs), 'beans': len(beans)}))
finally:
    try:
        send({'jsonrpc': '2.0', 'id': 99999, 'method': 'shutdown', 'params': None})
        send({'jsonrpc': '2.0', 'method': 'exit', 'params': None})
    except Exception:
        pass
    proc.kill()
