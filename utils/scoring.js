// Mirrors the scoring rule used in the local app: only mcq/yesno questions with a
// correctAnswer set count toward the score.
function computeTestScore(questions, answers) {
  const scorable = questions.filter((q) => (q.q_type === "mcq" || q.q_type === "yesno") && q.correct_answer);
  if (scorable.length === 0) return null;
  let correct = 0;
  scorable.forEach((q) => {
    const given = String(answers[q.id] ?? "").trim().toLowerCase();
    if (given === String(q.correct_answer).trim().toLowerCase()) correct++;
  });
  return Math.round((correct / scorable.length) * 100);
}

module.exports = { computeTestScore };
