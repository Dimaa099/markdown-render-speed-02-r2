// Entry driver for the markdown-render-speed-02 competition.
//
// The harness starts this file with `node main.ts` (Node 22 strips the
// types). It loads every case from cases.json in the input directory,
// renders each markdown string on its own through parse() from
// ./parse.js, and writes the resulting HTML strings, in the same order,
// as a JSON array to html.json in the output directory. When run outside
// the grader, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR point at the two
// directories instead of /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

type Case = { id: string; markdown: string };

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw: string = readFileSync(join(inputDir, "cases.json"), "utf8");
const cases: Case[] = JSON.parse(raw);

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(rendered));
