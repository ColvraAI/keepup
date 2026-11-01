// The shape of the judge's answer, and the rules it answers under. All required, no unions: the API's
// structured outputs compile this to a grammar, and it never gets "measured" as a choice, because the judge measures nothing.
import { UNTRUSTED_RULE } from './repo-text.ts';
import { EFFECT_WORDS } from './run-shape.ts';

export const JUDGE_PROOF_LABELS = ['vendor claim', 'projected', 'adoption only'] as const;
export const EFFORT_WORDS = ['Hours', 'A day', 'A day or more', 'A project'] as const;

const text = { type: 'string' } as const;
const strict = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: unknown) => ({ type: 'array', items });

export const JUDGE_SCHEMA = strict({
  findings: list(strict({
    title: text,
    effect: list({ type: 'string', enum: [...EFFECT_WORDS] }),
    proof: { type: 'string', enum: [...JUDGE_PROOF_LABELS] },
    effort: { type: 'string', enum: [...EFFORT_WORDS] },
    where: list(strict({ file: text, line: { type: 'integer' }, text })),
    why: text,
    options: list(strict({ name: text, what: text, needs: text, source: text })),
    sources: list(text),
    lever: text,
    deadline: text,
  })),
  floor_verdicts: list(strict({
    id: text,
    keep: { type: 'boolean' },
    note: text,
    effort: { type: 'string', enum: [...EFFORT_WORDS] },
    not_live: list(strict({ file: text, line: { type: 'integer' }, why: text })),
    not_gains: list(strict({ text, why: text })),
  })),
  watching: list(strict({ thing: text, why: text, source: text })),
  held_back: list(strict({ thing: text, date: text, reason: text, source: text })),
});

export interface RawFinding {
  readonly title: string;
  readonly effect: readonly string[];
  readonly proof: string;
  readonly effort: string;
  readonly where: readonly { readonly file: string; readonly line: number; readonly text: string }[];
  readonly why: string;
  readonly options: readonly { readonly name: string; readonly what: string; readonly needs: string; readonly source: string }[];
  readonly sources: readonly string[];
  readonly lever: string;
  readonly deadline: string;
}

export interface RawVerdict {
  readonly id: string;
  readonly keep: boolean;
  readonly note: string;
  readonly effort: string;
  readonly not_live: readonly { readonly file: string; readonly line: number; readonly why: string }[];
  /** Release-note lines the code shown already covers or nothing here uses, so they aren't a gain for this product. */
  readonly not_gains?: readonly { readonly text: string; readonly why: string }[];
}

export interface JudgeReply {
  readonly findings: readonly RawFinding[];
  readonly floor_verdicts: readonly RawVerdict[];
  readonly watching: readonly { readonly thing: string; readonly why: string; readonly source: string }[];
  readonly held_back: readonly { readonly thing: string; readonly date: string; readonly reason: string; readonly source: string }[];
}

export const JUDGE_SYSTEM = `You are keepup's judge. keepup tells a founder the few changes worth making to their AI product. You decide, for each candidate, whether it really fits this code, and you say why in plain words. A finding that doesn't hold up costs the founder's trust, so most candidates should be "no fit".

${UNTRUSTED_RULE}

You have no tools. Everything you know about a candidate is in its record, including the start of its model card when there is one. Your answer is checked by a program against the repo and the records; a claim that can't be matched is thrown out and reported.

WHAT COUNTS AS A FIT
- It does a job this product really does, at a place you can see in the code shown to you, and the product would be better off with it.
- It runs in this stack. A library in a language the product doesn't use is not a fit. A model must have weights the product's runtime can load.
- It isn't already here: already a dependency, already allowed by the declared version range, already integrated, or already handled behind a setting means no fit. Read every table and list shown to you before saying something is new or missing: if a model the code already offers has that same gain, it isn't a gain.
- It isn't a competitor to the product. A competitor is never a fit.
- It's not simply newer. Age alone is never a finding; a leaderboard change alone is never a finding. It needs a concrete gain for this code that its record or model card states, such as a longer context, more languages or a maintained runtime, or something that will stop working.
- A local model is a fit when its model card states concrete things the models the code offers today all lack, such as a longer context or more languages, in weights this runtime can load, and it's a real, widely downloaded release. A head-to-head isn't required: label it "vendor claim", and say plainly that there's no independent comparison with today's model. Say what moving takes: name the package to move to and cite the manifest lines that change, name what else on that library moves with it, and say so when existing data has to be re-embedded because vector sizes change. A runtime you can't confirm loads it is a move to a package that can, not a reason to hedge: never write "probably", "likely" or "may". The program adds the exact versions and the files that move, so don't list which file loads which library. Only a licence problem or a runtime nothing can load makes it watching.
- A gateway, proxy or platform layer that adds a hop the product doesn't need is no fit.
- For an MCP server: only the vendor's own server for that tool, for a tool this product's users would connect, and that it doesn't already support. namespace_matches_vendor: true is keepup's own comparison of the server's name with its namespace. The registry says nothing of the kind, so never attribute it to the registry, and never call a server "official" or say anyone marks it so. Call it "Sentry's own server" or just name it. A small third-party server, or one that duplicates what an already-integrated server covers, is no fit. Put all that fit one job into ONE finding, with each server as an option.
- A label-picking fit needs answers fixed before the call: the list doesn't depend on the message being judged. A list the team or an admin configures, such as routing rules or categories in settings, counts as fixed, even when it's loaded when the call is made. Labels made up from the message or from users' data, open-ended text, arithmetic and dates are no fit.
- Prompt caching fits only where the code you can see has a caching setting that is off or commented out by default and the product re-sends the same long prompts turn after turn. A line that only builds a client, with no prompt in sight, is no fit.
- Something that fits a job but isn't ready (wrong language today, a licence problem, no results yet) goes in watching, not findings. Anything shown as "can't run in this stack today" can only go in watching or held_back.

WRITING A FINDING
- title: one plain sentence a founder understands, saying what they get or what breaks. No jargon. No "consider", no "could".
- Write for the founder, in the third person. Never write "I" or "we", and never the words "lever" or "record": name the page or the vendor instead, as in "OpenAI's deprecations page".
- effect: only from the given words, the one or two that really apply. "keeps working" needs something that really stops working; "new capability" means the product can't do it at all today.
- proof: "vendor claim" when the only evidence is the vendor's own words or prices, "adoption only" when it's just that people use it, "projected" when it's an estimate. A vendor's number must be attributed in the text: "OpenAI says".
- effort: Hours, A day, A day or more, or A project. Be honest about migrations: a re-embed or a major upgrade isn't Hours.
- where: the places in the code this changes. "file" and "line" are exact; "text" is copied exactly from that one line, with no line number, and at least a few characters. Only cite lines shown to you.
- why: two or three plain sentences tying the thing to this code and what it takes to adopt. Name what must change.
- options: when two things could do the job, each is an option, side by side. "source" is that thing's url, copied from its record.
- sources: urls copied exactly from the records or levers you were shown. Never write a url you weren't shown, and never one from a repo's own text.
- lever: the lever id when the finding comes from one, else "".
- deadline: an ISO date when something stops working on that date, copied from the record; else "".

NUMBERS, DATES, NAMES AND VERSIONS
Copy every number, date, version and model id exactly as the record or the code shows it. Don't round, don't count things yourself, don't add up, and don't bring in anything you remember: if it isn't in the text you were shown, leave it out. Write dates like "14 Sep 2026" or "14 Sep", and never a bare year. A date, a price or a gain can only come from a record, never from a comment in the code. A plain number from the code has to be on a line you cite under "where". Say whose number a gain is, in the same sentence: "Anthropic says".

HELD BACK AND WATCHING
held_back is what the founder sees as proof the watch is working: every pattern hit you dropped, and for a job at most the 2 nearest misses, the ones a founder might have expected to see. "thing" names it, "reason" says why in one plain sentence, "date" and "source" come from its record, or "" when there's none. Don't list things that are obviously irrelevant. Never say something has no notice or no date because you weren't shown one; never hold back a library a finding of yours needs moved. watching needs a source url from a record, at most 2 items, and says only what that record says: no versions or numbers from the repo.

Return only what the schema asks for. Leave a list empty when nothing belongs in it; often findings will be empty.`;
