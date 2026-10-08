#!/usr/bin/env python3
"""Check a real installed Electron window and IPC in an isolated container."""
import json
import os
import pathlib
import signal
import subprocess
import time
import urllib.request
import websocket

profile = '/tmp/objectfilemanager-package-profile'
subprocess.run(['install', '-d', '-o', 'tester', '-g', 'tester', profile], check=True)
xvfb = subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1280x900x24', '-ac', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
log = open('/tmp/objectfilemanager-startup.log', 'w')
app = None
result = None
try:
    time.sleep(1)
    # Container-only sandbox override: nested Chromium namespaces are blocked by Docker.
    # Installed launchers never include this flag.
    emulation_flags = ['--no-zygote', '--in-process-gpu'] if os.environ.get('S3_EMULATED') == '1' else []
    executable = '/usr/bin/objectfilemanager'
    title = 'ObjectFileManager'
    app = subprocess.Popen(['runuser', '-u', 'tester', '--', 'env', 'DISPLAY=:99', executable, '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9222', f'--user-data-dir={profile}'] + emulation_flags, stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + int(os.environ.get("S3_SMOKE_TIMEOUT", "40"))
    result = None
    while time.monotonic() < deadline:
        if app.poll() is not None:
            raise RuntimeError(f'App exited early with {app.returncode}')
        try:
            with urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=2) as response:
                pages = json.load(response)
            page = next(p for p in pages if p.get('type') == 'page' and p.get('title') == title)
            ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=4, suppress_origin=True)
            ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': '(async () => ({ title: document.querySelector("h1")?.textContent, init: await window.s3.init(), jobs: await window.s3.jobs() }))()', 'awaitPromise': True, 'returnByValue': True}}))
            while True:
                message = json.loads(ws.recv())
                if message.get('id') == 1:
                    result = message.get('result', {}).get('result', {}).get('value')
                    break
            ws.close()
            if result and result.get('title') == 'Your files. Any cloud.':
                break
        except (OSError, ValueError, KeyError, StopIteration, websocket.WebSocketException):
            pass
        time.sleep(0.5)
    assert result and result['title'] == 'Your files. Any cloud.', result
    assert result['init']['version'] == os.environ['S3_PACKAGE_VERSION'], result
    assert result['init']['profiles'] == [] and result['jobs'] == [], result
    assert pathlib.Path(profile, 'transfers.sqlite').is_file()
    pathlib.Path(profile, 'keep-me.txt').write_text('User data must survive uninstall.\n')
    print('PASS: installed app opened its window, rendered onboarding, and initialized SQLite and IPC.')
finally:
    if app and app.poll() is None:
        os.killpg(app.pid, signal.SIGTERM)
        try:
            app.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(app.pid, signal.SIGKILL)
            app.wait()
    xvfb.terminate()
    xvfb.wait(timeout=10)
    log.close()
    if not result:
        print(pathlib.Path('/tmp/objectfilemanager-startup.log').read_text())
