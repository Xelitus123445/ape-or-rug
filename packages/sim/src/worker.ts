import { parentPort } from "node:worker_threads";
import { createEngine, fromHex } from "@ape/engine";
import { simulateChunk } from "./core.ts";

const engine = createEngine();

parentPort!.on("message", (job: { id: number; seed: string; first: number; rounds: number }) => {
  const result = simulateChunk(engine, fromHex(job.seed), job.first, job.rounds);
  parentPort!.postMessage({ id: job.id, result }, [
    result.stats.buffer as ArrayBuffer,
    result.lifeHist.buffer as ArrayBuffer,
    result.roundHist.buffer as ArrayBuffer,
    result.housePerRound.buffer as ArrayBuffer,
  ]);
});
