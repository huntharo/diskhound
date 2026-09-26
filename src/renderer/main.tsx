import { render } from "preact";

import { App } from "./App";
import { AgentConsentWindow } from "./components/AgentConsentWindow";
import { SystemWidget } from "./components/SystemWidget";
import "./index.css";

const params = new URLSearchParams(window.location.search);
const root = params.get("widget") === "1"
  ? <SystemWidget />
  : params.get("consent") === "1"
    ? <AgentConsentWindow />
    : <App />;

render(root, document.getElementById("app") as HTMLElement);
