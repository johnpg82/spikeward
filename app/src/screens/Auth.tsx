import { useState } from "preact/hooks";
import { post } from "../api";
import { Btn, ErrorText, Field, Logo } from "../ui";
import { issueMap } from "../ui";
import { useAsync } from "../util";

function Frame({ title, lede, children }: { title: string; lede: string; children: preact.ComponentChildren }) {
  return (
    <div class="center">
      <div class="center-inner">
        <div class="brand" style="padding:0"><Logo />Spikeward</div>
        <div>
          <h1>{title}</h1>
          <p class="lede">{lede}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Claim({ onDone }: { onDone: () => Promise<void> }) {
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, issues, run } = useAsync();
  const { byField } = issueMap(issues.map((i) => ({ ...i, path: ["c", ...i.path] })), "c");
  const submit = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      await post("/setup/claim", { secret, name, password });
      await onDone();
    });
  };
  return (
    <Frame title="Claim this Spikeward install" lede="You're the first visitor. Enter the SPIKEWARD_SECRET you set when you deployed, then create the admin account. This step locks after one admin exists.">
      <form class="card" onSubmit={submit}>
        <Field label="SPIKEWARD_SECRET" help="The secret value from your Worker's environment." error={byField.secret}>
          {(p) => <input {...p} type="password" autocomplete="off" required value={secret} onInput={(e) => setSecret(e.currentTarget.value)} />}
        </Field>
        <Field label="Admin name" error={byField.name}>
          {(p) => <input {...p} type="text" autocomplete="username" required maxLength={60} value={name} onInput={(e) => setName(e.currentTarget.value)} />}
        </Field>
        <Field label="Password" help="At least 10 characters." error={byField.password}>
          {(p) => <input {...p} type="password" autocomplete="new-password" required minLength={10} maxLength={200} value={password} onInput={(e) => setPassword(e.currentTarget.value)} />}
        </Field>
        <ErrorText error={error} />
        <div class="form-foot"><Btn type="submit" variant="primary" busy={busy} busyText="Claiming…">Claim and create admin</Btn></div>
      </form>
    </Frame>
  );
}

export function SignIn({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAsync();
  const submit = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      await post("/login", { name, password });
      await onDone();
    });
  };
  return (
    <Frame title="Sign in to Spikeward" lede="Use the admin name and password for this install.">
      <form class="card" onSubmit={submit}>
        <Field label="Name">
          {(p) => <input {...p} type="text" autocomplete="username" required value={name} onInput={(e) => setName(e.currentTarget.value)} />}
        </Field>
        <Field label="Password">
          {(p) => <input {...p} type="password" autocomplete="current-password" required value={password} onInput={(e) => setPassword(e.currentTarget.value)} />}
        </Field>
        <ErrorText error={error} />
        <div class="form-foot"><Btn type="submit" variant="primary" busy={busy} busyText="Signing in…">Sign in</Btn></div>
      </form>
    </Frame>
  );
}
