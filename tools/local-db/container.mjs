/**
 * Whether an existing local Postgres container is the one dev-local would
 * make: the compose file's pinned image (an older or newer major cannot run
 * on the other's data volume, and local SQL should meet the deployed server)
 * and its port published on 127.0.0.1 alone (it checks no password).
 */

/**
 * The reason to refuse the container, or undefined when it fits.
 * `found.portBindings` is `docker inspect`'s `.HostConfig.PortBindings`.
 */
export function containerMismatch(found, want) {
  const remove = `remove it (docker rm -f ${want.name}; its data volume stays)`;
  if (found.image !== want.image) {
    return `the container ${want.name} runs ${found.image}, not ${want.image}: ${remove}`;
  }
  const bindings = found.portBindings?.["5432/tcp"] ?? [];
  const published = bindings.map(({ HostIp, HostPort }) => `${HostIp || "0.0.0.0"}:${HostPort}`);
  const expected = `127.0.0.1:${want.port}`;
  if (published.length === 0 || published.some((address) => address !== expected)) {
    return `the container ${want.name} publishes ${published.join(", ") || "nothing"}, not only ${expected}: ${remove} or set LOCAL_DB_PG_PORT`;
  }
  return undefined;
}
