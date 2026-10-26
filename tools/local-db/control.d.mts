import type { IncomingMessage, ServerResponse } from "node:http";

export declare const CONTROL_HEADER: string;
export declare const CONTROL_HEADER_VALUE: string;
export declare function controlHandler(options: {
  onShutdown: () => void;
}): (req: IncomingMessage, res: ServerResponse) => void;
