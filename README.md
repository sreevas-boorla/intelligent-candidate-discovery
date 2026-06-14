# Redrob AI Candidate Discovery & Ranking Platform

This repository contains the solution for the **Intelligent Candidate Discovery & Ranking Challenge** by Team **Antigravity**.

Our ranker achieves a 0% honeypot rate in the top 100 by executing logic-grounded filters, and scores candidates across multiple job-fit dimensions and platform behavior indicators.

## 🚀 Setup & Reproduction

### Prerequisites
- **Python 3.7+** (No external packages required; uses standard libraries only).
- **Web Browser** (to view the interactive sandbox dashboard).

### Command to Reproduce the Submission CSV
Run the following command in the repository root to rank the candidates and produce the submission:
```bash
python rank.py --candidates ./candidates.jsonl --out ./team_antigravity.csv
```

### Validate the Submission CSV Format
To run the format check on the generated CSV:
```bash
python validate_submission.py team_antigravity.csv
```

---

## 🖥️ Run the Interactive Sandbox Dashboard

We built a local web-based dashboard that mirrors the Python ranking logic client-side in the browser. 

1. Launch a local web server from the repository root:
   ```bash
   python -m http.server 8000
   ```
2. Open your browser to:
   ```
   http://localhost:8000
   ```
3. Drag and drop `sample_candidates.json` or your full `candidates.jsonl` dataset to view candidate details, analyze charts, and download the validated CSV file.

---

## 💡 Methodology

### 1. Logic-Grounded Honeypot Filter
We preprocess the candidate pool to filter out all honeypots containing logically impossible profiles:
- **Expert skills with 0 months duration**: Multiple expert/advanced skills listed with no experience.
- **Calendar mismatch**: Job durations that contradict start and end dates by > 6 months.
- **Sum of jobs mismatch**: Total stated experience differing from the sum of job durations by > 5 years.
- **Job duration overflow**: Single job duration exceeding the total stated experience.

### 2. Multi-Dimensional Scoring
Valid candidates are scored based on:
- **Title Alignment (40%)**: Prioritizes Core AI/ML roles; penalizes service companies, academic-only profiles, and job hoppers.
- **Skills Score (30%)**: Matches search, retrieval, and NLP technologies, weighted by proficiency and usage duration. Keyword stuffers (zero mentions of ML in descriptions) are penalized.
- **Experience Score (15%)**: Maps experience against the target 5-9 years.
- **Location Score (10%)**: Prefers Pune/Noida local candidates or relocation-willing candidates.
- **Notice Period Score (5%)**: Prefers notice periods &le; 30 days.

### 3. Behavioral Platform Activity Multiplier
Applies multipliers based on recent logins, recruiter response rates, GitHub activity, saved profiles, and interview attendance.

### 4. Tie-breaking
In accordance with validator rules, ties in rounded scores are resolved alphabetically by `candidate_id` ascending.
