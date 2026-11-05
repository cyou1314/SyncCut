const API_ROOT = "https://open.feishu.cn";

export class FeishuApiError extends Error {
  constructor(message, { status, code, logId } = {}) {
    super(message);
    this.name = "FeishuApiError";
    this.status = status;
    this.code = code;
    this.logId = logId;
  }
}

export class FeishuBitableClient {
  constructor({ getAccessToken, fetchImpl = fetch }) {
    if (typeof getAccessToken !== "function") {
      throw new TypeError("getAccessToken must be a function.");
    }
    this.getAccessToken = getAccessToken;
    this.fetchImpl = fetchImpl;
  }

  async requestJson(path, { method = "GET", body } = {}) {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(new URL(path, API_ROOT), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      throw new FeishuApiError("Feishu Bitable API request failed.", {
        status: response.status,
        code: payload.code,
        logId: response.headers.get("x-tt-logid") ?? undefined,
      });
    }
    return payload.data ?? payload;
  }

  async createBase({ name }) {
    return this.requestJson('/open-apis/bitable/v1/apps', { method:'POST', body:{name, folder_token:''} });
  }

  async createTable({ appToken, name, primaryName }) {
    return this.requestJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, { method:'POST', body:{table:{name, fields:[{field_name:primaryName,type:1}]}} });
  }

  async createField({ appToken, tableId, spec }) {
    const {field_name,type,property} = spec;
    return this.requestJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`, { method:'POST', body:{field_name,type,...(property ? {property} : {})} });
  }

  async getBase({ appToken }) {
    return this.requestJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}`);
  }

  async listTables({ appToken, pageToken }) {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    return this.requestJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?${query}`);
  }

  async listFields({ appToken, tableId, pageToken }) {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    return this.requestJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${query}`);
  }

  async listRecords({ appToken, tableId, pageToken, pageSize = 100 }) {
    const path = new URL(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      API_ROOT,
    );
    path.searchParams.set("page_size", String(Math.min(Math.max(pageSize, 1), 500)));
    if (pageToken) path.searchParams.set("page_token", pageToken);
    return this.requestJson(path.pathname + path.search);
  }

  async getRecord({ appToken, tableId, recordId }) {
    return this.requestJson(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
    );
  }

  /**
   * Returns the raw Response so the caller can stream media to a device.
   * Pass the exact extra value returned by Bitable when advanced permissions
   * require it; do not synthesize permission metadata.
   */
  async downloadAttachment({ fileToken, extra, signal }) {
    const path = new URL(
      `/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      API_ROOT,
    );
    if (extra) {
      path.searchParams.set("extra", typeof extra === "string" ? extra : JSON.stringify(extra));
    }

    const token = await this.getAccessToken();
    const response = await this.fetchImpl(path, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });

    if (!response.ok) {
      throw new FeishuApiError("Feishu media download failed.", {
        status: response.status,
        logId: response.headers.get("x-tt-logid") ?? undefined,
      });
    }
    return response;
  }
}
