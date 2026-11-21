/**
 * The contribution, as one quiet card. It says what is set and what it is
 * for. "Change" opens the choices: nothing, smaller amounts, the amount
 * that the app suggests, and one larger amount.
 */
import { useState } from "preact/hooks";

export function Support(props: { usd: number; choices: number[]; onPick: (usd: number) => void; title: string; detail?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="support">
      <span class="support-sun" aria-hidden="true" />
      <strong>{props.title}</strong>
      <span class="support-text">
        {props.detail ?? "Chronobox is free software. This pays for the work that keeps it safe."}{" "}
        {open ? null : (
          <button type="button" class="link-button" onClick={() => setOpen(true)}>
            Change
          </button>
        )}
      </span>
      {open ? (
        <div class="support-pills" role="radiogroup" aria-label="Contribution">
          {props.choices.map((usd) => (
            <button type="button" role="radio" aria-checked={usd === props.usd} key={usd} class={usd === props.usd ? "fund-stop fund-stop-on" : "fund-stop"} onClick={() => props.onPick(usd)}>
              {usd === 0 ? "Nothing" : `$${usd}`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** For an amount so small that the app asks for nothing. */
export function OnUs(props: { from: number }) {
  return (
    <div class="support support-plain">
      <span class="support-sun" aria-hidden="true" />
      <strong>Trying it out? This one is on us.</strong>
      <span class="support-text">Chronobox asks for a contribution only from ${props.from} on.</span>
    </div>
  );
}
