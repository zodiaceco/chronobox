/**
 * The marks of the networks that Chronobox works on, as small inline
 * pictures. No image file and no request: the page loads nothing from
 * another place. A network without a mark here gets a plain dot.
 */
import type { ComponentChildren } from "preact";

function Frame(props: { size: number; children: ComponentChildren }) {
  return (
    <svg class="chain-logo" viewBox="0 0 32 32" width={props.size} height={props.size} aria-hidden="true" focusable="false">
      {props.children}
    </svg>
  );
}

const MARKS: Record<number, ComponentChildren> = {
  // Ethereum: the diamond in its six faces.
  1: (
    <>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff" transform="translate(16 16) scale(0.1) translate(-128 -128)">
        <path d="M131.482 188.289v58.964l72.876-102.69-72.876 43.726Z" opacity="0.8" />
        <path d="M201.709 125.347 131.482 8.747v84.8l70.227 31.8Z" opacity="0.8" />
        <path d="M131.482 100.153v72.214l69.564-40.414-69.564-31.8Z" opacity="0.55" />
        <path d="m54.626 125.347 70.226-116.6v84.8l-70.226 31.8Z" />
        <path d="M124.846 100.153v72.214l-69.564-40.414 69.564-31.8Z" opacity="0.75" />
        <path d="M124.851 188.289v58.964l-72.876-102.69 72.876 43.726Z" />
      </g>
    </>
  ),
  // Base: the blue square.
  8453: <rect x="1" y="1" width="30" height="30" rx="4" fill="#0000FF" />,
  // Arbitrum: the hexagon with the letter in it.
  42161: (
    <>
      <rect width="32" height="32" rx="8" fill="#1B4ADD" />
      <path d="M16 5.4l9.2 5.3v10.6L16 26.6l-9.2-5.3V10.7z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" />
      <path d="M9.9 20.6l3.7-9.4h1.8l-3.7 9.4zM12.9 20.6l3.7-9.4h1.8l3.7 9.4h-1.8L17.5 13l-2.8 7.6z" fill="#fff" />
    </>
  ),
  // Gnosis: the owl.
  100: (
    <path
      fill="#04795B"
      fill-rule="evenodd"
      d="M16 32C7.163 32 0 24.837 0 16S7.163 0 16 0s16 7.163 16 16-7.163 16-16 16zm8.777-21.5-.798.81c.635 1.011.834 2.28.4 3.494-.726 2.06-2.975 3.146-5.024 2.41-.29-.11-.562-.24-.798-.405L16 19.403l-2.23-2.28a4.024 4.024 0 0 1-3.61.459 4.09 4.09 0 0 1-2.43-5.224c.11-.331.273-.626.454-.901l-.961-.975-.182.312a10.735 10.735 0 0 0-1.54 5.537C5.48 22.2 10.196 27 15.98 27H16c5.785 0 10.482-4.764 10.5-10.632 0-1.95-.526-3.863-1.523-5.537l-.2-.331zM9.363 12.652a2.225 2.225 0 0 0-.435 1.325c0 1.195.96 2.17 2.14 2.17.489 0 .942-.165 1.305-.46l-3.01-3.035zm10.5 2.851c.344.24.743.368 1.197.368 1.178 0 2.14-.975 2.14-2.17 0-.442-.127-.865-.363-1.214l-2.974 3.016zm-3.827 2.281 8.56-8.645-.327-.368A11.184 11.184 0 0 0 15.927 5h-.018c-3.137 0-6.057 1.288-8.197 3.587l-.344.368 8.668 8.83zm-7.254-8.83a10.082 10.082 0 0 1 7.145-2.924h.019c2.72 0 5.331 1.122 7.253 3.072l-7.163 7.23-7.254-7.377z"
    />
  ),
};

export function ChainLogo(props: { chainId: number; size?: number }) {
  return <Frame size={props.size ?? 18}>{MARKS[props.chainId] ?? <circle cx="16" cy="16" r="10" fill="currentColor" opacity="0.35" />}</Frame>;
}
