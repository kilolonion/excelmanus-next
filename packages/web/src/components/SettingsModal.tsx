import { useState } from "react";
import {
  createProfile,
  deleteProfile,
  setDefaultProfile,
  setSettingsOpen,
  testProfile,
  useApp,
} from "../store.ts";
import { S } from "../strings.ts";

export function SettingsModal() {
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);
  const [form, setForm] = useState({ name: "", provider: "", model: "", baseUrl: "", apiKey: "" });
  const [testing, setTesting] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  const preset = providers.find((p) => p.id === form.provider);

  return (
    <div className="modal-mask">
      <div
        className="modal"
        role="dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") setSettingsOpen(false);
        }}
      >
        <div className="row-between">
          <h3>{S.modelProfiles}</h3>
          <button type="button" className="btn ghost" onClick={() => setSettingsOpen(false)}>
            {S.close}
          </button>
        </div>

        <div className="profile-list">
          {profiles.map((p) => (
            <div key={p.id} className="profile-item">
              <div>
                <strong>{p.name}</strong>
                <span className="muted small">
                  {" "}
                  {p.provider} / {p.model}
                </span>
                {p.isDefault && <span className="badge ok">{S.isDefault}</span>}
              </div>
              <div className="profile-actions">
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={testing === p.id}
                  onClick={() => {
                    setTesting(p.id);
                    void testProfile(p.id).then((r) => {
                      setTesting(null);
                      setTestMsg((m) => ({
                        ...m,
                        [p.id]: r.ok ? S.testOk : `${S.testFailed}：${r.message ?? ""}`,
                      }));
                    });
                  }}
                >
                  {testing === p.id ? S.testing : S.testConnection}
                </button>
                {!p.isDefault && (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => void setDefaultProfile(p.id)}
                  >
                    {S.setDefault}
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost danger small"
                  onClick={() => void deleteProfile(p.id)}
                >
                  {S.deleteProfile}
                </button>
              </div>
              {testMsg[p.id] && <div className="small muted">{testMsg[p.id]}</div>}
            </div>
          ))}
        </div>

        <h4>{S.addProfile}</h4>
        <form
          className="profile-form"
          onSubmit={(e) => {
            e.preventDefault();
            void createProfile({
              name: form.name,
              provider: form.provider,
              model: form.model,
              ...(form.baseUrl !== "" ? { baseUrl: form.baseUrl } : {}),
              apiKey: form.apiKey,
            }).then(() =>
              setForm({ name: "", provider: form.provider, model: "", baseUrl: "", apiKey: "" }),
            );
          }}
        >
          <input
            placeholder={S.profileName}
            value={form.name}
            required
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <select
            value={form.provider}
            required
            onChange={(e) => {
              const p = providers.find((x) => x.id === e.target.value);
              setForm({ ...form, provider: e.target.value, baseUrl: p?.defaultBaseUrl ?? "" });
            }}
          >
            <option value="">{S.provider}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <input
            placeholder={S.model}
            value={form.model}
            required
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <input
            placeholder={S.baseUrl}
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />
          <input
            placeholder={S.apiKey}
            type="password"
            value={form.apiKey}
            required
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
          <button type="submit" className="btn primary" disabled={preset === undefined}>
            {S.save}
          </button>
        </form>
      </div>
    </div>
  );
}
