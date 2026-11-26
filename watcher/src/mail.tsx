/** @jsxImportSource react */
// The emails as HTML, rendered with react-email: tables and inline styles that mail programs show alike. Each email
// also has a plain text part, written in email.ts, for the programs that show only text.
//
// Node runs this file through jsx.mjs (esbuild), the bundles through build.mjs. The pragma above keeps React as the
// JSX of this file also where another project (the app, with Preact) checks it.
//
// Every value goes in as a text child or an attribute, so React escapes it. Nothing here is raw HTML.
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text, render } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';

const ink = '#111111';
const muted = '#555555';
const faint = '#777777';
const font = '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif';

const styles = {
  body: { margin: 0, padding: '24px 0', backgroundColor: '#f5f5f7', fontFamily: font, color: ink },
  card: { maxWidth: '520px', margin: '0 auto', padding: '28px', backgroundColor: '#ffffff', border: '1px solid #e3e3e6', borderRadius: '20px' },
  mark: { margin: '0 0 18px', fontSize: '12px', fontWeight: 600, letterSpacing: '0.14em', color: ink },
  title: { margin: '0 0 14px', fontSize: '22px', lineHeight: '28px', fontWeight: 700, color: ink },
  p: { margin: '0 0 14px', fontSize: '16px', lineHeight: '24px', color: muted, overflowWrap: 'anywhere' },
  button: { display: 'inline-block', padding: '14px 28px', borderRadius: '999px', backgroundColor: ink, color: '#ffffff', fontSize: '16px', fontWeight: 600, textDecoration: 'none' },
  hr: { margin: '22px 0', borderColor: '#e3e3e6' },
  foot: { margin: '0 0 8px', fontSize: '13px', lineHeight: '20px', color: faint, overflowWrap: 'anywhere' },
  link: { color: faint, textDecoration: 'underline' },
} satisfies Record<string, CSSProperties>;

/** Text with paragraphs (an empty line) and line breaks, as the alerts are written. */
function Paragraphs({ text }: { text: string }) {
  return text.split(/\n{2,}/).map((para, i) => (
    <Text key={i} style={styles.p}>
      {para.split('\n').map((line, j) => (j === 0 ? line : [<br key={j} />, line]))}
    </Text>
  ));
}

type FrameProps = {
  /** The line that mail programs show next to the subject. */
  preview: string;
  title: string;
  children: ReactNode;
  /** Under the line: which Chronobox, and the link that stops the alerts. */
  foot?: { box: string; stop: string };
};

function Frame({ preview, title, children, foot }: FrameProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.card}>
          <Text style={styles.mark}>CHRONOBOX ALERTS</Text>
          <Heading as="h1" style={styles.title}>{title}</Heading>
          {children}
          {foot ? (
            <>
              <Hr style={styles.hr} />
              <Text style={styles.foot}>{foot.box}</Text>
              <Text style={styles.foot}>
                <Link href={foot.stop} style={styles.link}>Stop these alerts</Link>
              </Text>
            </>
          ) : null}
        </Container>
      </Body>
    </Html>
  );
}

/** The one email before the confirmation. Its button is the only way on. */
export function confirmHtml(o: { vault: string; network: string; link: string; cancel: string }): Promise<string> {
  return render(
    <Frame preview="Confirm the alerts for the Chronobox." title="Confirm the alerts">
      {/* One string: React puts a comment between text parts. */}
      <Text style={styles.p}>{`You asked for the alerts of the Chronobox ${o.vault} on ${o.network} at this address. Confirm it, and they start:`}</Text>
      <Section style={{ margin: '6px 0 20px' }}>
        <Button href={o.link} style={styles.button}>Confirm the alerts</Button>
      </Section>
      <Text style={styles.p}>If it was not you, do nothing: we delete this request after one day.</Text>
      <Text style={styles.p}>
        <Link href={o.cancel} style={{ color: muted, textDecoration: 'underline' }}>Not you? Cancel</Link> this request, and every other one to this address, now.
      </Text>
    </Frame>,
    { pretty: false },
  );
}

/**
 * An alert, or a notice that somebody stopped: the text as it is, one button that opens the Chronobox in the app, and
 * the foot with the stop link.
 */
export function alertHtml(o: { title: string; message: string; box: string; stop: string; open?: string | null }): Promise<string> {
  return render(
    <Frame preview={o.message.split('\n')[0].slice(0, 140)} title={o.title} foot={{ box: o.box, stop: o.stop }}>
      <Paragraphs text={o.message} />
      {o.open ? (
        <Section style={{ margin: '6px 0 0' }}>
          <Button href={o.open} style={styles.button}>Open the Chronobox</Button>
        </Section>
      ) : null}
    </Frame>,
    { pretty: false },
  );
}
