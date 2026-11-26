import type { ComponentChildren } from "preact";
import { DELAY_DOCS, ROLES_DOCS } from "../lib/chains.ts";

/**
 * Privacy policy (#/privacy) and imprint (#/imprint). Same column as the
 * technical page. Every claim here must stay true for the code: when the app
 * starts to store, send or load something new, change this page in the same
 * commit.
 */

const UPDATED = "23 November 2026";

function Ext(props: { href: string; children: ComponentChildren }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer noopener">
      {props.children}
    </a>
  );
}

function Back() {
  return (
    <a class="wiz-back tech-back" href="#/">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      Back
    </a>
  );
}

function Block(props: { title: string; children: ComponentChildren }) {
  return (
    <section class="tech-block legal-block">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

const Company = () => (
  <p>
    Zodiac Labs GmbH
    <br />
    Kolonnenstraße 8
    <br />
    10827 Berlin
    <br />
    Germany
  </p>
);

export function PrivacyPage() {
  return (
    <section class="tech legal">
      <Back />

      <header class="tech-head">
        <h1>Privacy</h1>
        <p class="lead">
          The Chronobox app has no account, no server and no analytics. Your data stays in your browser and on the blockchain. Alerts are
          the one exception, and you choose them.
        </p>
        <p class="tech-note">Last updated {UPDATED}</p>
      </header>

      <Block title="Who is responsible">
        <p>The controller under the GDPR is:</p>
        <Company />
        <p>
          Email: <a href="mailto:privacy@zodiac.eco">privacy@zodiac.eco</a>
        </p>
      </Block>

      <Block title="What we do not do">
        <ul>
          <li>
            We do not ask for your name or any other account data. The app never asks for your email address. If you want alerts by
            email, you give it to our alert service: see "Alerts" below.
          </li>
          <li>
            We do not run a server for this app. The page does not send data to us or to anybody else. Alerts are a service of their own:
            see "Alerts" below.
          </li>
          <li>We do not use cookies, analytics, tracking pixels or advertising.</li>
          <li>We do not load fonts, scripts or images from other websites.</li>
        </ul>
        <p class="tech-note">
          The browser enforces this. The page has a Content Security Policy with <code>connect-src 'none'</code>, so it cannot open a
          network connection of its own.
        </p>
      </Block>

      <Block title="When you open the website">
        <p>
          Our hosting provider delivers the files of this website. To do this, its servers process your IP address, the time, the file
          you ask for and the browser identifier that your browser sends. The provider keeps these server logs for a short time for
          security and to find faults. We do not combine them with other data.
        </p>
        <p>
          The hosting provider is Vercel Inc., USA. Vercel processes the data on our behalf under a data processing agreement. Data goes
          to the USA on the basis of the Standard Contractual Clauses of the European Commission.
        </p>
        <p class="tech-note">Legal basis: Art. 6(1)(f) GDPR. Our legitimate interest is to deliver the website safely.</p>
      </Block>

      <Block title="What stays in your browser">
        <p>To work without a server, the app keeps some data in the local storage of your browser:</p>
        <ul>
          <li>the addresses and networks of the Chronoboxes you made or opened,</li>
          <li>the wallet and the account you connected last,</li>
          <li>the tokens you added,</li>
          <li>the transactions you sent, so that the app can find them again,</li>
          <li>a new wallet that you asked your guardian to agree to,</li>
          <li>the version of the app you saw last.</li>
        </ul>
        <p>
          This data does not leave your device. We cannot see it. To delete it, clear the site data for this website in your browser.
        </p>
        <p class="tech-note">
          Legal basis: § 25(2) no. 2 TDDDG and Art. 6(1)(b) GDPR. The storage is necessary for the service you ask for.
        </p>
      </Block>

      <Block title="Your wallet and the blockchain">
        <p>
          The app reads and sends everything through the wallet you connect. Your wallet sends these requests to a blockchain node
          (RPC provider) that your wallet chose. That provider sees your wallet address, your IP address and the Chronoboxes you look
          at. The privacy policy of your wallet and of its RPC provider apply to this. We do not control them.
        </p>
        <p>
          If your wallet does not know a network yet, the app suggests a public RPC address for it. Your wallet asks you first. If you
          accept, your wallet then uses that provider.
        </p>
        <p>
          Transactions on a blockchain are public and permanent. Anybody can see your Chronobox, its balance, its withdrawals and the
          wallet that made it. Nobody can delete this data, and so we cannot delete it either.
        </p>
        <p>
          If you add a guardian, the address of the guardian is on the blockchain too. You send the link to your guardian yourself, by a
          way you choose. It does not pass through us.
        </p>
      </Block>

      <Block title="Contribution">
        <p>
          When you make a Chronobox, you can send a voluntary contribution to Zodiac. This is a normal transaction on the blockchain. We
          see it as everybody sees it. We do not connect it to a person.
        </p>
      </Block>

      <Block title="Calendar file">
        <p>
          The app makes the calendar file in your browser. It holds the times of the reminders only, no amount, no address and no link.
          If your calendar copies its entries to a cloud, the privacy policy of your calendar applies.
        </p>
      </Block>

      <Block title="Alerts">
        <p>
          Alerts are optional. They do not come from this page. They come from an alert service that we run, and you start them yourself,
          in Telegram or by email. To send you an alert, this service must know who follows a Chronobox, and we can see that.
        </p>
        <h3>In Telegram</h3>
        <p>When you press Start in Telegram, the alert service keeps:</p>
        <ul>
          <li>the number of your Telegram chat,</li>
          <li>the address and the network of the Chronobox you follow,</li>
          <li>since when you follow it.</li>
        </ul>
        <p>
          It keeps no name, no username, no phone number and no message. We keep the list encrypted. That protects a copy of the list. It
          does not hide the list from us: with it we can see that a Telegram account follows a Chronobox, and so how much money that
          account may control.
        </p>
        <p>
          Telegram delivers the alerts. Telegram knows the phone number of your account, sees that you follow a Chronobox, and can read
          what the bot sends you. The privacy policy of Telegram applies to this.
        </p>
        <p>To delete your data, send /stop to the bot. That ends the alerts and deletes your chat from the list.</p>
        <h3>By email</h3>
        <p>
          The app opens a page of the alert service. You give your email address there, not in the app. The alert service then sends
          you one email with a link, and the alerts start only when you confirm with it. When you confirm, the alert service keeps:
        </p>
        <ul>
          <li>your email address,</li>
          <li>the address and the network of the Chronobox you follow,</li>
          <li>since when you follow it.</li>
        </ul>
        <p>
          We keep this list encrypted too, and the same holds: it does not hide the list from us. We can see that an email address
          follows a Chronobox. A request that nobody confirms is deleted after one day. The confirmation email also has a link to cancel
          it.
        </p>
        <p>
          Resend Inc., USA, sends the emails on our behalf. Resend gets your email address and the text of each email. Your email
          provider sees the emails too.
        </p>
        <p>
          To delete your data, use the link at the end of every alert. That ends the alerts and deletes your email address from the
          list.
        </p>
        <p>
          To stop the page from being misused, the alert service counts how many requests come from one visitor. It counts a keyed hash
          of your IP address, not the address itself, and only for a short time.
        </p>
        <h3>Where it runs</h3>
        <p>
          The alert service runs at Vercel Inc., USA, and keeps the encrypted lists at Upstash Inc., USA. They and Resend process the
          data on our behalf. Data goes to the USA on the basis of the Standard Contractual Clauses of the European Commission.
        </p>
        <p>
          If you do not want us, Telegram or Resend to know this, do not use our alert service. Its code is public, and you can run it yourself on a server.
          Then we learn nothing about you. "Get told" in your Chronobox shows how.
        </p>
        <p class="tech-note">Legal basis: Art. 6(1)(b) GDPR. We need this data for the service you ask for.</p>
      </Block>

      <Block title="Links to other websites">
        <p>
          Some links open other websites, for example block explorers or GitHub. When you open them, their own privacy policies apply.
          This page sends no referrer to them.
        </p>
      </Block>

      <Block title="When you write to us">
        <p>
          If you send us an email, we use your email address and your message to answer you. We delete them when we no longer need
          them, unless the law tells us to keep them.
        </p>
        <p class="tech-note">Legal basis: Art. 6(1)(b) and (f) GDPR.</p>
      </Block>

      <Block title="Your rights">
        <p>Under the GDPR you have the right to:</p>
        <ul>
          <li>get a copy of the personal data we have about you (Art. 15),</li>
          <li>correct it (Art. 16) or have it deleted (Art. 17),</li>
          <li>limit how we use it (Art. 18),</li>
          <li>get it in a common format (Art. 20),</li>
          <li>object to how we use it on the basis of our legitimate interest (Art. 21).</li>
        </ul>
        <p>
          Write to <a href="mailto:privacy@zodiac.eco">privacy@zodiac.eco</a>. You can also complain to a supervisory authority. Ours is
          the Berliner Beauftragte für Datenschutz und Informationsfreiheit.
        </p>
      </Block>

      <Block title="Changes">
        <p>
          When the app changes what it stores or sends, we change this page. The date at the top shows the last change. The code is
          public on <Ext href="https://github.com/zodiaceco/chronobox">GitHub</Ext>, so you can check every claim here.
        </p>
      </Block>
    </section>
  );
}

export function TermsPage() {
  return (
    <section class="tech legal">
      <Back />

      <header class="tech-head">
        <h1>Terms</h1>
        <p class="lead">Chronobox is free software. Your wallet controls your Chronobox. We cannot move, stop or recover your money.</p>
        <p class="tech-note">Last updated {UPDATED}</p>
      </header>

      <Block title="1. Who we are">
        <p>
          Chronobox is made by Zodiac Labs GmbH, Kolonnenstraße 8, 10827 Berlin, Germany (<a href="#/imprint">imprint</a>). These terms
          apply when you use this website and the app on it. When you create a Chronobox, you agree to them.
        </p>
      </Block>

      <Block title="2. What Chronobox is">
        <p>
          Chronobox is a free app that runs in your browser. It helps you set up a vault on a blockchain from open-source contracts by
          others: Safe and the Zodiac <Ext href={DELAY_DOCS}>Delay</Ext> and <Ext href={ROLES_DOCS}>Roles</Ext> modules. Your wallet signs every step.
        </p>
        <p>We never hold your money or your keys. We cannot withdraw, cancel, freeze or recover anything in your Chronobox.</p>
        <p>Chronobox is not financial, legal or tax advice, and it is not a financial service.</p>
      </Block>

      <Block title="3. What you are responsible for">
        <ul>
          <li>Your wallet controls your Chronobox. If you can no longer sign with it and have not turned on guardian recovery, the money in your Chronobox is gone. We cannot get it back.</li>
          <li>Check each transaction in your wallet before you sign it. Transactions on a blockchain are final.</li>
          <li>
            Look at your Chronobox regularly. If somebody steals your key, the delay protects you only if you cancel their withdrawal in
            time.
          </li>
          <li>
            If you add a guardian, choose a wallet you trust. A guardian can cancel every withdrawal and cannot withdraw. If you also turn on
            guardian recovery, your guardian can start a recovery to a wallet they choose after a long wait unless you stop it in time.
          </li>
          <li>You pay the network fees.</li>
          <li>Use Chronobox only where it is legal for you, and not for crime or to get around sanctions.</li>
        </ul>
      </Block>

      <Block title="4. Risks">
        <p>
          Chronobox is new and experimental. The app and the contracts can have errors, even though the contracts were audited.
          Blockchains, wallets and tokens can fail or change. Use Chronobox at your own risk, and only with money you can afford to have
          locked or lost.
        </p>
        <p>
          We do not promise that this website is always available. Your Chronobox does not need it. You can always use it with other
          tools, because the code and the contracts are public.
        </p>
      </Block>

      <Block title="5. Contribution">
        <p>
          A contribution is voluntary. It is a gift to Zodiac and gives you no extra rights. Because it is a blockchain transaction, we
          cannot send it back.
        </p>
      </Block>

      <Block title="6. Liability">
        <p>
          Chronobox is free. So we are liable only for intent and gross negligence. This limit does not apply to injury to life, body or
          health, to claims under the German Product Liability Act, or where the law does not allow a limit.
        </p>
      </Block>

      <Block title="7. Open source">
        <p>
          The code is open source under the <Ext href="https://github.com/zodiaceco/chronobox">MIT License</Ext>. The names Zodiac and
          Chronobox and their logos are not part of that license.
        </p>
      </Block>

      <Block title="8. Changes and law">
        <p>
          We can change these terms. The version on this page applies from the date at the top. German law applies. If you are a consumer
          in another EU country, the mandatory consumer law of your country still protects you. If one part of these terms is not valid,
          the rest still applies.
        </p>
        <p>
          Questions: <a href="mailto:ops@zodiac.eco">ops@zodiac.eco</a>
        </p>
      </Block>
    </section>
  );
}

export function ImprintPage() {
  return (
    <section class="tech legal">
      <Back />

      <header class="tech-head">
        <h1>Imprint</h1>
        <p class="lead">Chronobox is made by Zodiac Labs GmbH.</p>
      </header>

      <Block title="Provider">
        <p class="tech-note">Information under § 5 DDG and § 18 MStV.</p>
        <Company />
      </Block>

      <Block title="Contact">
        <p>
          Email: <a href="mailto:ops@zodiac.eco">ops@zodiac.eco</a>
        </p>
      </Block>

      <Block title="Commercial register">
        <p>Amtsgericht Charlottenburg, HRB 289442 B</p>
      </Block>

      <Block title="VAT identification number">
        <p>DE466266040 (§ 27a UStG)</p>
      </Block>

      <Block title="Managing directors">
        <p>
          Jan-Felix Schwarz
          <br />
          Philipp Giese
        </p>
      </Block>

      <Block title="Responsible for content">
        <p>Under § 18(2) MStV: Jan-Felix Schwarz, Kolonnenstraße 8, 10827 Berlin, Germany</p>
      </Block>

      <Block title="Consumer dispute resolution">
        <p>We do not take part in dispute resolution before a consumer arbitration board, and we are not obliged to (§ 36 VSBG).</p>
      </Block>

      <Block title="Liability for content">
        <p>
          We are responsible for our own content on these pages under the general laws (§ 7(1) DDG). Under §§ 8 to 10 DDG we do not have
          to monitor information from others that we transmit or store, or look for signs of illegal activity. Our duty to remove or
          block information under the general laws stays the same.
        </p>
      </Block>

      <Block title="Liability for links">
        <p>
          This website links to websites of others. We have no influence on their content and are not liable for it. The provider of each
          linked page is responsible for its content. We checked the linked pages when we added the links and found no illegal content.
        </p>
      </Block>

      <Block title="Copyright">
        <p>
          The code of Chronobox is open source under the MIT License. See the <Ext href="https://github.com/zodiaceco/chronobox">repository</Ext>.
          The names Zodiac and Chronobox, the logos and the videos are not part of that license. German copyright law applies to them.
        </p>
      </Block>
    </section>
  );
}
