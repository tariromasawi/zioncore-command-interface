import { useMemo, useState } from "react";
import { PageHead, Panel } from "@/components/bits";

function Field({ id, label, value, set, step = 1, suffix }: { id: string; label: string; value: number; set: (n: number) => void; step?: number; suffix?: string }) {
  return (
    <label htmlFor={id} className="block">
      <span className="font-mono text-[10px] uppercase text-muted-foreground">{label}{suffix ? " (" + suffix + ")" : ""}</span>
      <input id={id} type="number" inputMode="decimal" min={0} step={step} value={Number.isFinite(value) ? value : 0}
        onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))} data-testid={"input-" + id}
        className="mt-1 w-full bg-input/40 border border-input px-2 py-2 font-mono text-base sm:text-sm min-h-11" />
    </label>
  );
}
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export default function ContinuityPage() {
  const [hours, setHours] = useState(6);
  const [rate, setRate] = useState(42.5);
  const [infra, setInfra] = useState(18.4);
  const [margin, setMargin] = useState(22);
  const [clients, setClients] = useState(3);
  const r = useMemo(() => {
    const labour = hours * rate;
    const cost = labour + infra;
    const price = margin >= 100 ? 0 : cost / (1 - margin / 100);
    return { labour, cost, price, profit: price - cost, monthly: price * clients, annual: price * clients * 12 };
  }, [hours, rate, infra, margin, clients]);
  return (
    <div>
      <PageHead kicker="Prototype · local only" title="Continuity service pricing">Arithmetic on your inputs, in this browser only. Nothing is saved, sent or sold. No sales exist; no earnings are verified.</PageHead>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Panel kicker="Inputs" title="Per client, per month">
          <div className="grid grid-cols-2 gap-3">
            <Field id="hours" label="Hours" value={hours} set={setHours} step={0.5} />
            <Field id="rate" label="Hourly rate" value={rate} set={setRate} step={0.5} suffix="USD" />
            <Field id="infra" label="Infra cost" value={infra} set={setInfra} step={0.1} suffix="USD" />
            <Field id="margin" label="Target margin" value={margin} set={(n) => setMargin(Math.min(95, n))} suffix="%" />
            <Field id="clients" label="Hypothetical clients" value={clients} set={(n) => setClients(Math.round(n))} />
          </div>
          <button onClick={() => { setHours(6); setRate(42.5); setInfra(18.4); setMargin(22); setClients(3); }} data-testid="button-reset-pricing" className="mt-3 text-xs font-mono underline py-2">reset inputs</button>
        </Panel>
        <Panel kicker="Computed" title="Price breakdown" action={<span className="font-mono text-[10px] text-accent border border-accent/40 px-1.5 py-0.5">HYPOTHETICAL</span>}>
          <dl className="font-mono text-sm divide-y divide-border" aria-live="polite">
            {[["Labour = hours x rate", r.labour], ["Cost = labour + infra", r.cost], ["Price = cost / (1 - margin)", r.price], ["Margin per client", r.profit], ["Monthly if " + clients + " clients", r.monthly], ["Annualised (x12)", r.annual]].map(([k, v], i) => (
              <div key={i} className="flex justify-between gap-3 py-2"><dt className="text-muted-foreground text-xs">{k}</dt><dd className={i === 2 ? "text-primary text-lg" : ""} data-testid={"text-calc-" + i}>{money(v as number)}</dd></div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] text-muted-foreground">Projection, not revenue. Verified earnings to date: none.</p>
        </Panel>
      </div>
    </div>
  );
}
