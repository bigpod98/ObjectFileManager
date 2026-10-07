// Keystone authentication wraps the existing Swift adapter so transfers retain
// the same cancellation, path handling, and conditional-operation guarantees.
function tokenUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    !url ||
    !/^https?:\/\//i.test(value) ||
    /[\s\\]/.test(value) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP or HTTPS Keystone URL without credentials, query, or fragment.",
    );
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/v3/auth/tokens"))
    url.pathname += url.pathname.endsWith("/v3")
      ? "/auth/tokens"
      : "/v3/auth/tokens";
  return url.toString();
}

async function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let cancel;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function client(profile, createSwift) {
  const url = tokenUrl(profile.authUrl);
  const lifetime = new AbortController();
  let authentication,
    adapter,
    session,
    expires = 0,
    project;
  async function authenticate() {
    const domain = profile.domainId
      ? { id: profile.domainId }
      : { name: profile.domainName || "Default" };
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auth: {
          identity: {
            methods: ["password"],
            password: {
              user: {
                name: profile.username,
                password: profile.password,
                domain,
              },
            },
          },
          scope: {
            project: profile.projectId
              ? { id: profile.projectId }
              : { name: profile.projectName, domain },
          },
        },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Keystone authentication failed (HTTP ${response.status}). Check your credentials and project.`,
      );
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1024 * 1024)
        throw new Error("Keystone service catalog is too large.");
      chunks.push(chunk);
    }
    const token = response.headers.get("x-subject-token");
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString()).token;
    } catch {
      throw new Error("Keystone returned an invalid authentication response.");
    }
    const expiry = Date.parse(data?.expires_at);
    if (
      !token ||
      !data?.project?.id ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now()
    )
      throw new Error("Keystone returned an invalid or expired project token.");
    const endpoint = data.catalog
      ?.find((service) => service.type === "object-store")
      ?.endpoints?.find(
        (entry) =>
          entry.interface === "public" &&
          (!profile.region ||
            entry.region === profile.region ||
            entry.region_id === profile.region),
      );
    if (!endpoint?.url)
      throw new Error(
        "No public Swift endpoint found for the selected region.",
      );
    const storageUrl = endpoint.url.replace(/\/+$/, "");
    if (
      new URL(url).protocol === "https:" &&
      new URL(storageUrl).protocol === "http:"
    )
      throw new Error(
        "Keystone authenticated over HTTPS but returned an HTTP Swift endpoint. Refusing to send the authentication token over an insecure connection.",
      );
    if (
      session &&
      (session.endpoint !== storageUrl || project !== data.project.id)
    )
      throw new Error(
        "Keystone returned a different Swift account. Create a new connection before continuing.",
      );
    lifetime.signal.throwIfAborted();
    if (!adapter) {
      const nextSession = {
        ...profile,
        swiftAuth: "token",
        authUrl: undefined,
        endpoint: storageUrl,
        swiftToken: token,
      };
      adapter = createSwift(nextSession);
      session = nextSession;
      project = data.project.id;
    } else session.swiftToken = token;
    // Refresh early, including deployments with tokens shorter than five minutes.
    expires = expiry - Math.min(60000, (expiry - Date.now()) / 10);
  }
  async function ready(signal) {
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (!adapter || Date.now() >= expires) {
      if (!authentication)
        authentication = authenticate().finally(() => {
          authentication = undefined;
        });
      await waitFor(authentication, signal);
    }
    return adapter;
  }
  async function run(method, args, signal, retry = false) {
    const current = await ready(signal);
    const token = session.swiftToken;
    try {
      return await current[method](...args);
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 401) throw error;
      if (session.swiftToken === token) expires = 0;
      // Streams cannot be replayed. The durable queue owns upload retries.
      if (!retry) throw error;
      return run(method, args, signal);
    }
  }
  return {
    provider: "OpenStack Swift",
    capabilities: require("../provider-capabilities.cjs").capabilities({
      ...profile,
      provider: "OpenStack Swift",
    }),
    async send(command, options = {}) {
      try {
        return await run(
          "send",
          [command, options],
          options.abortSignal,
          /^(List|Head|Get)/.test(command.constructor.name),
        );
      } catch (error) {
        command.input?.Body?.destroy?.();
        throw error;
      }
    },
    async upload(input, options = {}) {
      try {
        return await run("upload", [input, options], options.abortSignal);
      } catch (error) {
        input.Body?.destroy?.();
        throw error;
      }
    },
    signedUrl(input, expiresIn) {
      return run("signedUrl", [input, expiresIn]);
    },
    destroy() {
      lifetime.abort();
      adapter?.destroy();
    },
  };
}

module.exports = { tokenUrl, client };
