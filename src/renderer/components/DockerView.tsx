import { useEffect, useState } from "preact/hooks";
import type { DockerInventory } from "../../shared/docker";
import { nativeApi } from "../nativeApi";

const PAGE_SIZE = 100;
export function DockerView() {
  const [inventory, setInventory] = useState<DockerInventory | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => () => { void nativeApi.cancelDockerInventory(); }, []);
  const refresh = async () => {
    setBusy(true); setInventory(null); setMessage(""); setPage(0);
    try {
      const result = await nativeApi.getDockerInventory();
      if (result?.ok) setInventory(result.inventory);
      else setMessage(result?.message ?? "Docker bridge unavailable.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try {
      const result = await nativeApi.removeDockerImage(id);
      setMessage(result.message);
      // Any attempt can race with Docker activity. Require fresh data after it.
      setInventory(null);
    } catch (error) { setInventory(null); setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <section className="docker-view">
    <h2>Docker storage</h2>
    <p>Read the local Docker daemon on demand. Docker must already be running; remote contexts are excluded.</p>
    <button className="action-btn" disabled={busy} onClick={() => void refresh()}>{busy ? "Working…" : "Refresh Docker inventory"}</button>
    {busy && <button className="action-btn" onClick={() => void nativeApi.cancelDockerInventory()}>Cancel</button>}
    <p role="status">{message}</p>
    <p>Image provenance is unknown: tags and registry references do not prove whether an image was pulled, built locally, or both. Keep images you cannot reproduce.</p>
    {inventory && <>
      <p><strong>{inventory.context}</strong> · {inventory.endpoint} · Updated {new Date(inventory.collectedAt).toLocaleTimeString()}</p>
      <table><thead><tr><th>Resource</th><th>Total</th><th>Active</th><th>Docker size</th><th>Docker reclaimable estimate</th></tr></thead>
        <tbody>{inventory.usage.map((item) => <tr key={item.type}><td>{item.type}</td><td>{item.total}</td><td>{item.active}</td><td>{item.size}</td><td>{item.reclaimable}</td></tr>)}</tbody></table>
      <p>Build cache, containers and volumes are separate resources and cannot be removed here. External buildx builders may have additional cache. These figures are daemon estimates, collected in separate requests.</p>
      <h3>Images ({inventory.images.length})</h3>
      <p>Logical sizes include shared layers and must not be added together. Unique size is not guaranteed reclaimed space. Docker.raw and other VM disks are not image cleanup targets; removing images may not shrink host VM storage.</p>
      <div className="docker-table"><table><thead><tr><th>Image (first tag)</th><th>Logical size</th><th>Shared</th><th>Unique</th><th>Container references</th><th>Provenance</th><th>Action</th></tr></thead>
        <tbody>{inventory.images.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => <tr key={item.id}>
          <td title={item.id}>{item.name}<br/><small>{item.id.slice(0, 19)}</small></td><td>{item.logicalSize}</td><td>{item.sharedSize}</td><td>{item.uniqueSize}</td><td>{item.containers ?? "Unknown"}</td><td>Unknown</td>
          <td><button className="action-btn danger" disabled={busy || item.containers !== 0} onClick={() => void remove(item.id)}>Remove…</button></td>
        </tr>)}</tbody></table></div>
      {!inventory.images.length && <p>No images reported by Docker.</p>}
      <button className="action-btn" disabled={page === 0 || busy} onClick={() => setPage(page - 1)}>Previous</button>
      <span> Page {page + 1} of {Math.max(1, Math.ceil(inventory.images.length / PAGE_SIZE))} </span>
      <button className="action-btn" disabled={(page + 1) * PAGE_SIZE >= inventory.images.length || busy} onClick={() => setPage(page + 1)}>Next</button>
    </>}
  </section>;
}
