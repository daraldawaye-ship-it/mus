import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { correctOptionText, orderCachedQuestionCards, visibleQuestionResult, type QuestionResultSnapshot, type QuestionResult } from "../apps/web/src/question-result.ts";

const unanswered: QuestionResultSnapshot = {
  myLastSelectedAnswer: null, myLastCorrect: null, correctAnswer: null,
  myLastPoints: null, myLastComment: null, otherOptionCounts: null,
};
const wrong: QuestionResult = {
  selectedAnswer: 2, correct: false, correctAnswer: 1, points: 0,
  comment: null, otherOptionCounts: [2, 1],
};
const correct: QuestionResult = {
  selectedAnswer: 1, correct: true, correctAnswer: 1, points: 5,
  comment: null, otherOptionCounts: [2, 1],
};

test("unanswered question does not claim a verdict or reveal a correct option", () => {
  assert.equal(visibleQuestionResult(unanswered, null, null), null);
});

test("confirmed answer remains visible when a background list is stale", () => {
  assert.deepEqual(visibleQuestionResult(unanswered, null, wrong), wrong);
  const previous: QuestionResultSnapshot = {
    ...unanswered, myLastSelectedAnswer: 1, myLastCorrect: true, correctAnswer: 1,
    myLastPoints: 5,
  };
  assert.deepEqual(visibleQuestionResult(previous, correct, wrong), wrong);
});

test("older answered questions show their own server-confirmed correct or incorrect result", () => {
  const row = {
    ...unanswered, myLastSelectedAnswer: 2, myLastCorrect: false,
    correctAnswer: 1, myLastPoints: 0, otherOptionCounts: [4, 2],
  };
  assert.deepEqual(visibleQuestionResult(row, correct, null), {
    selectedAnswer: 2, correct: false, correctAnswer: 1, correctText: null, points: 0,
    comment: null, otherOptionCounts: [4, 2],
  });
});

test("answer history preserved on the device shows correctness even when GET personal fields are redacted", () => {
  assert.deepEqual(visibleQuestionResult(unanswered, correct, null), correct);
  assert.deepEqual(visibleQuestionResult(unanswered, wrong, null), wrong);
  assert.equal(visibleQuestionResult(unanswered, {
    ...wrong, selectedAnswer: 0,
  }, null), null);
});

test("UI shows prominent feedback on question card and answers tab without duplicate grading", () => {
  const page = readFileSync("apps/web/src/pages/QuestionsPage.tsx", "utf8");
  const style = readFileSync("apps/web/src/styles.css", "utf8");
  assert.match(page, /setConfirmedAnswers\(prev=>/);
  assert.match(page, /visibleQuestionResult\(question,savedAnswers\[question\.id\],confirmedAnswers\[question\.id\]\)/);
  assert.match(page, /إجابتك صحيحة/);
  assert.match(page, /إجابتك خاطئة/);
  assert.match(page, /الإجابة الصحيحة:/);
  assert.match(page, /otherOptionCounts\?\.\[i\]/);
  assert.match(style, /\.question-result-correct \{/);
  assert.match(style, /\.question-result-wrong \{/);
  assert.match(style, /border-color: #a3ff12/);
  assert.match(style, /border-color: #ff4b4b/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\) \{\s*\.question-search[^\n]*\n\}/);
});

test("employee's own cashbox remains the default sales account", () => {
  const source = readFileSync("apps/web/src/pages/CommercePages.tsx", "utf8");
  const logic = readFileSync("apps/web/src/invoice-account-default.ts", "utf8");
  assert.match(source, /initialInvoiceAccount\(kind, defaultCashbox, configuredPurchaseAccount\)/);
  assert.match(source, /صندوق مبيعات الموظف افتراضيًا/);
  assert.match(logic, /kind === "sale" \? employeeCashbox : configuredPurchaseAccount/);
});

test("correct-answer text is shown for both correct and incorrect submitted answers", () => {
  assert.equal(correctOptionText(["الصحيح", "الخاطئ"], wrong), "الصحيح");
  assert.equal(correctOptionText(["الصحيح", "الخاطئ"], correct), "الصحيح");
  assert.equal(correctOptionText(["الصحيح", "الخاطئ"], null), null);
  // Historical answer text wins over a question changed after answering.
  assert.equal(correctOptionText(["نص جديد", "الخاطئ"], {
    ...wrong, correctText: "النص الصحيح وقت الإجابة",
  }), "النص الصحيح وقت الإجابة");
  assert.equal(correctOptionText(["أ", "ب"], {
    ...correct, correctAnswer: null, selectedAnswer: 2,
  }), "ب");
  assert.equal(correctOptionText(["أ", "ب"], {
    ...wrong, correctAnswer: null,
  }), null);
});

test("offline refresh reorders only downloaded questions, skips duplicates and prioritizes unanswered", () => {
  const rows = orderCachedQuestionCards([
    [{id:3, priority:4}, {id:1,priority:1}, {id:4,priority:3}],
    [{id:1,priority:1}, {id:2,priority:2}, {id:5,priority:1}],
  ],new Set([1,3]), 20);
  assert.deepEqual(rows.map(row=>row.id), [5,2,4,1,3]);
  assert.equal(orderCachedQuestionCards([[{id:1,priority:1}]],new Set([1])).length,1);
});

test("offline update uses existing user-scoped saved question lists, not a new server request", () => {
  const page=readFileSync("apps/web/src/pages/QuestionsPage.tsx","utf8");
  assert.match(page,/if \(!navigator\.onLine\) \{/);
  assert.match(page,/savedRead<Page<Question>>\(sourceUrl\)/);
  assert.match(page,/personalAnswerHistory\(user\.id,scope\)/);
  assert.match(page,/orderCachedQuestionCards\(pages,answeredIds,20\)/);
  assert.match(page,/client\.setQueryData\(/);
  assert.match(page,/تم تحديث وترتيب الأسئلة المحفوظة/);
});
