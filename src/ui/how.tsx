/**
 * "How it works" in four glyphs, drawn with the parts of the mark: the blue
 * horizon, the path of the sun, the sun. Captions are plain HTML.
 */
import type { ComponentChildren } from "preact";

function Art(props: { children: ComponentChildren }) {
  return (
    <svg class="hiw-art" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false">
      {props.children}
    </svg>
  );
}

/** The mark's arc and horizon, with the sun at the start or at the end of its path. */
function Dial(props: { sunX: number }) {
  return (
    <g transform="translate(0 6)">
      <path d="M6.06 45.81A26 26 0 0 1 57.94 45.81" fill="none" stroke="currentColor" stroke-width="5" />
      <circle cx={props.sunX} cy="37.63" r="7.5" fill="currentColor" />
      <path d="M2 50A44 44 0 0 1 62 50Z" fill="#469CED" />
    </g>
  );
}

function Step(props: { n: number; title: string; text: string; art: ComponentChildren; children?: ComponentChildren }) {
  return (
    <li>
      <Art>{props.art}</Art>
      <div class="hiw-copy">
        <span class="hiw-num">{props.n}</span>
        <p class="hiw-title">{props.title}</p>
        <p class="hiw-text">{props.text}</p>
        {props.children}
      </div>
    </li>
  );
}

export function HowItWorks() {
  return (
    <div class="hiw">
      <ol>
        <Step
          n={1}
          title="Set up"
          text="Create your Timebox with your wallet."
          art={
            <>
              <path d="M15 19L43 9.5L47 19" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" />
              <rect x="8.5" y="19" width="47" height="35" rx="7" fill="none" stroke="currentColor" stroke-width="5" />
              <rect x="37" y="29.5" width="21" height="14" rx="7" fill="#469CED" />
              <circle cx="44.5" cy="36.5" r="3.5" fill="currentColor" />
            </>
          }
        />
        <Step n={2} title="Set the delay" text="Choose how long every withdrawal must wait." art={<Dial sunX={7.98} />}>
          <span class="hiw-pills">
            <span>1 day</span>
            <span>1 week</span>
            <span aria-label="Custom">+</span>
          </span>
        </Step>
        <Step
          n={3}
          title="Deposit"
          text="Send money to your Timebox."
          art={
            <>
              <path d="M32 3V13M26 8L32 14L38 8" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
              <circle cx="32" cy="29" r="9" fill="#469CED" />
              <path d="M8.5 32V45a9 9 0 0 0 9 9H46.5a9 9 0 0 0 9-9V32" fill="none" stroke="currentColor" stroke-width="5" />
            </>
          }
        />
        <Step n={4} title="Peace of mind" text="Nobody can take it in a hurry." art={<Dial sunX={56.02} />} />
      </ol>
    </div>
  );
}
