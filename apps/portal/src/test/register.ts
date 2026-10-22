import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
// Tells React that state updates in tests happen inside act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
