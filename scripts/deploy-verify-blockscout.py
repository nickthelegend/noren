#!/usr/bin/env python3
"""Verify one contract on a Blockscout explorer through its v2 API (standard JSON input, constructor
arguments autodetected by Blockscout). No API key needed. Used for docs/DEPLOY.md#verified-source.

  cd packages/<pkg>    # at the commit the address was deployed from
  forge verify-contract <address> <path:Name> --show-standard-json-input > /tmp/input.json
  python3 scripts/deploy-verify-blockscout.py https://explorer.testnet.arc.io <address> <path:Name> \
      /tmp/input.json v0.8.28+commit.7893614a
"""
import sys, json, time, subprocess, urllib.request, uuid
base, addr, contract, jf, ver = sys.argv[1:6]
name = contract.split(':')[1]
def get():
    for i in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{base}/api/v2/smart-contracts/{addr}", headers={'User-Agent': 'curl/8.7.1'}), timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if '429' in str(e): time.sleep(20); continue
            if '404' in str(e): return {}
            time.sleep(5)
    return {}
d = get()
if d.get('is_verified'):
    print(f"{addr} {name}: already verified ({d.get('name')})"); sys.exit(0)
boundary = uuid.uuid4().hex
def part(n, v, fn=None):
    h = f'--{boundary}\r\nContent-Disposition: form-data; name="{n}"' + (f'; filename="{fn}"\r\nContent-Type: application/json' if fn else '') + '\r\n\r\n'
    return h.encode() + (v if isinstance(v, bytes) else v.encode()) + b'\r\n'
body = part('compiler_version', ver) + part('contract_name', name) + part('autodetect_constructor_args', 'true') + part('license_type', 'mit') + part('files[0]', open(jf, 'rb').read(), 'input.json') + f'--{boundary}--\r\n'.encode()
for i in range(8):
    req = urllib.request.Request(f"{base}/api/v2/smart-contracts/{addr}/verification/via/standard-input", data=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}', 'User-Agent': 'curl/8.7.1'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: resp = r.read().decode(); break
    except urllib.error.HTTPError as e:
        resp = e.read().decode()
        if e.code == 429: time.sleep(25); continue
        print(f"{addr} {name}: submit error {e.code} {resp[:200]}"); sys.exit(1)
for i in range(20):
    time.sleep(10)
    d = get()
    if d.get('is_verified'):
        print(f"{addr} {name}: VERIFIED ({d.get('name')}, {d.get('compiler_version')}, runs {d.get('optimization_runs')})"); sys.exit(0)
print(f"{addr} {name}: not verified after polling (submit said {resp[:150]})"); sys.exit(2)
