import json, sys, urllib.request, os, zipfile
BASE = "http://localhost:3011/api/v1"
def token():
    req = urllib.request.Request(f"{BASE}/auth/login", data=json.dumps({"email":"admin@cro-one.com","password":"admin"}).encode(), headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(req))["accessToken"]
def fetch(ev, ver, ws, outroot, label, include_source=None):
    q = "" if include_source is None else f"?includeSource={'true' if include_source else 'false'}"
    req = urllib.request.Request(f"{BASE}/view-analyses/evidences/{ev}/versions/{ver}/audit-report{q}", headers={"Authorization": f"Bearer {token()}", "X-Workspace-Id": ws})
    resp = urllib.request.urlopen(req); data = resp.read()
    os.makedirs(outroot, exist_ok=False)
    zp = os.path.join(outroot, f"{label}.zip"); open(zp, "wb").write(data)
    ex = os.path.join(outroot, "unzipped"); os.makedirs(ex)
    zipfile.ZipFile(zp).extractall(ex)
    print(label, resp.status, resp.headers.get("Content-Disposition"), len(data), sorted(zipfile.ZipFile(zp).namelist())[:12])
if __name__ == "__main__":
    ev, ver, ws, out, label = sys.argv[1:6]
    inc = None if len(sys.argv) < 7 else sys.argv[6] == "true"
    fetch(ev, ver, ws, out, label, inc)
