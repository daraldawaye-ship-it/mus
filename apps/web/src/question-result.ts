/** Personal answer feedback is private to the current user, never shared across users. */
export type QuestionResult = {
  selectedAnswer: number;
  correct: boolean;
  correctAnswer: number | null;
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
      points: question.myLastPoints ?? 0,
      comment: question.myLastComment,
      otherOptionCounts: question.otherOptionCounts ?? [],
    };
  }
  return isConfirmed(saved) ? saved : null;
}
