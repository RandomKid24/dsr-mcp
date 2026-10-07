"""The only module that talks to the CRM, and only over its HTTP API."""
import httpx


class CRMError(Exception):
    def __init__(self, status, body):
        self.status, self.body = status, body
        super().__init__(f"CRM answered {status}: {body}")


class Conflict(CRMError):
    """The entry is already in the DSR; `existing` is the stored one."""

    @property
    def existing(self):
        return self.body.get("existing", {})


class CRM:
    def __init__(self, url, token, transport=None):
        if not url or not token:
            raise CRMError(0, "Not signed in. Run `dsr-mcp login --url <crm url>` (or set CRM_URL and CRM_TOKEN).")
        self.http = httpx.Client(
            base_url=f"{url}/api/v1",
            headers={"Authorization": f"Bearer {token}"},
            timeout=20,
            transport=transport,
        )

    def _call(self, method, path, **kw):
        res = self.http.request(method, path, **kw)
        try:
            body = res.json()
        except ValueError:
            body = {"error": res.text[:200]}
        if res.status_code == 409:
            raise Conflict(409, body)
        if res.status_code >= 400:
            raise CRMError(res.status_code, body.get("error", body))
        return body

    def me(self):
        return self._call("GET", "/users/me/")

    def projects(self):
        return self._call("GET", "/projects/")

    def today(self, date=None):
        return self._call("GET", "/dsr/today/", params={"date": date} if date else None)

    def activities(self, date=None):
        return self._call("GET", "/activities/today/", params={"date": date} if date else None)

    def create(self, entry):
        return self._call("POST", "/dsr/", json=entry)

    def update(self, entry_id, fields):
        return self._call("PUT", f"/dsr/{entry_id}/", json=fields)
