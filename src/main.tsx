import { render } from "preact";
import { App } from "./app.tsx";
import "./fonts.css";
import "./styles.css";

render(<App />, document.getElementById("app")!);
