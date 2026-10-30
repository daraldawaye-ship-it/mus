/** Personal answer feedback is private to the current user, never shared across users. */
export type QuestionResult = {
  selectedAnswer: number;
  correct: boolean;
  correctAnswer: number | null;
  /** Correct choice as recorded at the time of the answer, not after edits. */
  correctText?: string | null;
  points: number;
  firstAttempt?: boolean;
  comment: string | null;
  otherOptionCounts: number[];
};

export type QuestionResultSnapshot = {
  myLastSelectedAnswer: number | null;
  myLastCorrect: boolean | null;
  correctAnswer: number | null;
  myLastPoints: number | null;
  myLastComment: string | null;
  myLastCorrectText?: string | null;
  otherOptionCounts: number[] | null;
};

function isConfirmed(result: QuestionResult | null | undefined): result is QuestionResult {
  return !!result && Number.isInteger(result.selectedAnswer) &&
    result.selectedAnswer > 0 && typeof result.correct === "boolean";
}

/** The just-confirmed POST must not be hidden by a stale background GET. */
export function visibleQuestionResult(
  question: QuestionResultSnapshot,
  saved: QuestionResult | null | undefined,
  justConfirmed: QuestionResult | null | undefined,
): QuestionResult | null {
  if (isConfirmed(justConfirmed)) return justConfirmed;
  if (typeof question.myLastSelectedAnswer === "number" &&
      typeof question.myLastCorrect === "boolean") {
    return {
      selectedAnswer: question.myLastSelectedAnswer,
      correct: question.myLastCorrect,
      correctAnswer: question.correctAnswer,
      correctText: question.myLastCorrectText ??
        (saved?.selectedAnswer === question.myLastSelectedAnswer &&
         saved?.correct === question.myLastCorrect ? saved?.correctText : null),
      points: question.myLastPoints ?? 0,
      comment: question.myLastComment,
      otherOptionCounts: question.otherOptionCounts ?? [],
    };
  }
  return isConfirmed(saved) ? saved : null;
}

/** Only reveal the correct choice after the user's answer is server-confirmed. */
export function correctOptionText(
  options: readonly string[],
  outcome: QuestionResult | null,
): string | null {
  if (!outcome || typeof outcome.correct !== "boolean") return null;
  if (typeof outcome.correctText === "string" && outcome.correctText.trim()) {
    return outcome.correctText;
  }
  // Old cached answers may not include the correct index. When the answer
  // was correct, the user's chosen option is necessarily the right answer.
  const index = typeof outcome.correctAnswer === "number" &&
    Number.isInteger(outcome.correctAnswer) ? outcome.correctAnswer :
    outcome.correct ? outcome.selectedAnswer : null;
  if (index === null || index < 1 || index > options.length) return null;
  const text = options[index - 1];
  return typeof text === "string" && text.trim() ? text : null;
}

/** Reorder the already-downloaded questions without claiming new network data.
 * Deduplicate pages and prefer questions without a confirmed or queued answer.
 */
export function orderCachedQuestionCards<T extends { id: number; priority: number }>(
  pages: readonly (readonly T[])[],
  answered: ReadonlySet<number>,
  maxItems = 20,
): T[] {
  const seen = new Set<number>();
  const items: T[] = [];
  for (const page of pages) for (const question of page) {
    if (!Number.isSafeInteger(question.id) || seen.has(question.id)) continue;
    seen.add(question.id);
    items.push(question);
  }
  return items.sort((a,b) =>
    Number(answered.has(a.id)) - Number(answered.has(b.id)) ||
    a.priority - b.priority ||
    a.id - b.id).slice(0,maxItems);
}
