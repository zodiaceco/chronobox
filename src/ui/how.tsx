/**
 * "How it works" in four pictures, drawn with the parts of the mark: the
 * Zodiac tile, the path of the sun, the sun, a coin. Captions are plain HTML.
 */
import type { ComponentChildren } from "preact";
import { DepositArt, NightArt, SunArt, WalletArt } from "./art.tsx";

function Step(props: { n: number; title: string; text: string; art: ComponentChildren; children?: ComponentChildren }) {
  return (
    <li>
      {props.art}
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
        <Step n={1} title="Connect" text="Connect your wallet. There is nothing to set up." art={<WalletArt class="hiw-art" />} />
        <Step n={2} title="Lock" text="Choose the money that should not leave in a hurry." art={<DepositArt class="hiw-art" />} />
        <Step n={3} title="Unlocking waits" text="You choose how long. Nobody can make it faster." art={<SunArt class="hiw-art" deg={150} />}>
          <span class="hiw-pills">
            <span>1 day</span>
            <span>1 week</span>
            <span aria-label="Custom">+</span>
          </span>
        </Step>
        <Step n={4} title="Peace of mind" text="Nobody can take it in a hurry." art={<NightArt class="hiw-art" />} />
      </ol>
    </div>
  );
}
