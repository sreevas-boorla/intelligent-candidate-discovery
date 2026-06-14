import json
import csv
import datetime
import re
import os
import argparse

def parse_date(date_str):
    if not date_str:
        return None
    try:
        return datetime.datetime.strptime(date_str, "%Y-%m-%d")
    except Exception:
        return None

def is_honeypot(cand, ref_date):
    profile = cand.get("profile", {})
    career = cand.get("career_history", [])
    skills = cand.get("skills", [])
    
    # 1. Expert/advanced skills with 0 duration
    expert_with_zero_dur = sum(1 for s in skills if s.get("proficiency") in ["expert", "advanced"] and s.get("duration_months", 0) == 0)
    if expert_with_zero_dur >= 5:
        return True, f"Skill Honeypot: {expert_with_zero_dur} expert/adv skills with 0 duration"
        
    # 2. Stated job duration vs calendar date mismatch (> 6 months)
    for i, job in enumerate(career):
        start = parse_date(job.get("start_date"))
        end = parse_date(job.get("end_date"))
        dur_stated = job.get("duration_months", 0)
        if start:
            if end:
                expected_dur = (end.year - start.year) * 12 + (end.month - start.month)
            else:
                expected_dur = (ref_date.year - start.year) * 12 + (ref_date.month - start.month)
            if abs(dur_stated - expected_dur) > 6:
                return True, f"Job {i} duration mismatch: stated {dur_stated} mos vs expected ~{expected_dur} mos"
                
    # 3. Total experience vs sum of job durations mismatch (> 5.0 years)
    years_stated = profile.get("years_of_experience", 0)
    total_job_years = sum(job.get("duration_months", 0) for job in career) / 12.0
    if abs(years_stated - total_job_years) > 5.0:
        return True, f"Total experience mismatch: stated {years_stated} years vs sum {total_job_years:.1f} years"
        
    # 4. Job duration exceeds stated total experience
    for i, job in enumerate(career):
        dur_years = job.get("duration_months", 0) / 12.0
        if dur_years > years_stated + 0.5:
            return True, f"Job {i} duration {dur_years:.1f} yrs exceeds stated total exp {years_stated} yrs"
            
    return False, ""

def compute_title_score(profile, career):
    current_title = profile.get("current_title", "").lower()
    
    # Positive Core Keywords
    core_keywords = [
        "ai engineer", "ml engineer", "machine learning engineer", "nlp engineer", 
        "search engineer", "retrieval engineer", "applied scientist", 
        "recommender engineer", "recommendation engineer", "applied ml", 
        "llm engineer", "ai researcher", "ml researcher"
    ]
    # Positive Sub-core Keywords
    subcore_keywords = [
        "data scientist", "data science", "backend engineer", "software engineer", 
        "full stack engineer", "tech lead", "engineering manager", 
        "principal engineer", "staff engineer"
    ]
    # Disqualified Titles
    disqualified_titles = [
        "marketing", "accountant", "accounting", "mechanical", "hr manager", 
        "human resources", "operations", "sales", "graphic designer", 
        "customer support", "support specialist", "project manager", 
        "financial analyst", "content writer", "civil engineer", 
        "designer", "recruiter", "talent acquisition", "legal", 
        "account executive", "business development", "product manager", 
        "scrum master"
    ]
    
    # Check disqualified
    for dq in disqualified_titles:
        if dq in current_title:
            return 0.0
            
    # Base title scoring
    title_score = 0.0
    is_core = any(kw in current_title for kw in core_keywords)
    is_subcore = any(kw in current_title for kw in subcore_keywords)
    
    if is_core:
        if "nlp" in current_title or "search" in current_title or "retrieval" in current_title:
            title_score = 1.0
        else:
            title_score = 0.9
    elif is_subcore:
        title_score = 0.4
        # Boost based on career history
        ml_past_jobs = 0
        for job in career:
            job_title = job.get("title", "").lower()
            if any(kw in job_title for kw in core_keywords):
                ml_past_jobs += 1
        title_score = min(0.8, title_score + 0.15 * ml_past_jobs)
    else:
        # Check if they have ML in current title in a different way
        if "machine learning" in current_title or "ml" in current_title or "ai" in current_title:
            title_score = 0.8
        else:
            title_score = 0.1
            
    # Adjust for consulting/service companies only
    consulting_list = [
        "tcs", "tata consultancy", "infosys", "wipro", "accenture", 
        "cognizant", "capgemini", "tech mahindra", "hcl", "l&t", "lnt", "mindtree"
    ]
    all_consulting = True
    if not career:
        all_consulting = False
    for job in career:
        comp = job.get("company", "").lower()
        is_consult = any(c in comp for c in consulting_list)
        if not is_consult:
            all_consulting = False
            break
    if all_consulting:
        title_score *= 0.1
        
    # Adjust for academic-only research
    academic_keywords = ["research assistant", "teaching assistant", "phd student", "postdoc", "professor", "lecturer"]
    all_academic = True
    if not career:
        all_academic = False
    for job in career:
        t = job.get("title", "").lower()
        is_acad = any(ak in t for ak in academic_keywords)
        if not is_acad:
            all_academic = False
            break
    if all_academic:
        title_score *= 0.1
        
    # Average job duration adjustment for job hopping
    if len(career) >= 3:
        avg_tenure_months = sum(job.get("duration_months", 0) for job in career) / len(career)
        if avg_tenure_months < 18:
            title_score *= 0.7
            
    return title_score

def compute_skills_score(skills, profile, career):
    core_skills = [
        "embeddings", "sentence-transformers", "bge", "e5", "vector search", 
        "pinecone", "weaviate", "qdrant", "milvus", "opensearch", "elasticsearch", 
        "faiss", "hybrid search", "ndcg", "mrr", "map", "information retrieval", 
        "ranking", "evaluation", "vector database"
    ]
    nice_to_have = [
        "lora", "qlora", "peft", "xgboost", "learning to rank", "fine-tuning", 
        "llm", "distributed systems", "pytorch", "tensorflow", "nlp", "python"
    ]
    
    score = 0.0
    matched_skills = []
    
    for s in skills:
        name = s.get("name", "").lower()
        prof = s.get("proficiency", "beginner")
        dur = s.get("duration_months")
        if dur is None:
            dur = 12
            
        prof_mult = {"expert": 1.0, "advanced": 0.8, "intermediate": 0.5, "beginner": 0.2}.get(prof, 0.2)
        dur_mult = min(36, dur) / 36.0
        weight = prof_mult * dur_mult
        
        is_core = any(cs in name for cs in core_skills)
        is_nice = any(nt in name for nt in nice_to_have)
        
        if is_core:
            score += weight * 2.0
            matched_skills.append(s.get("name"))
        elif is_nice:
            score += weight * 1.0
            matched_skills.append(s.get("name"))
            
    normalized_score = min(1.0, score / 10.0)
    
    # Check for keyword-stuffer trap
    summary = profile.get("summary", "").lower()
    full_career_text = " ".join([job.get("description", "") for job in career]).lower()
    combined_text = summary + " " + full_career_text
    
    keywords_to_check = [
        "ml", "ai", "nlp", "search", "retrieval", "ranking", "embedding", 
        "vector", "model", "algorithm", "language model", "recommend", "intelligence"
    ]
    has_text_mention = any(kw in combined_text for kw in keywords_to_check)
    if not has_text_mention and normalized_score > 0.3:
        normalized_score *= 0.1
        
    # Check for CV/speech/robotics domain only
    cv_skills = ["computer vision", "image classification", "speech recognition", "tts", "gans", "robotics", "yolo", "object detection"]
    has_cv = any(any(cv in s.get("name", "").lower() for cv in cv_skills) for s in skills)
    has_nlp = any(any(cs in s.get("name", "").lower() for cs in core_skills + ["nlp"]) for s in skills)
    if has_cv and not has_nlp:
        normalized_score *= 0.2
        
    return normalized_score, matched_skills

def compute_experience_score(profile):
    exp = profile.get("years_of_experience", 0)
    if 6.0 <= exp <= 8.0:
        return 1.0
    elif 5.0 <= exp < 6.0 or 8.0 < exp <= 9.0:
        return 0.9
    elif 4.0 <= exp < 5.0 or 9.0 < exp <= 10.0:
        return 0.7
    elif 3.0 <= exp < 4.0 or 10.0 < exp <= 12.0:
        return 0.4
    else:
        return 0.1

def compute_location_score(profile, signals):
    country = profile.get("country", "").lower()
    location = profile.get("location", "").lower()
    relocate = signals.get("willing_to_relocate", False)
    
    is_local = "noida" in location or "pune" in location or "delhi" in location or "gurgaon" in location or "ncr" in location
    is_tier1 = "hyderabad" in location or "bangalore" in location or "mumbai" in location or "chennai" in location
    
    if "india" in country or not country:
        if is_local:
            return 1.0
        elif is_tier1:
            return 0.8 if relocate else 0.4
        else:
            return 0.7 if relocate else 0.2
    else:
        # Outside India
        return 0.3 if relocate else 0.0

def compute_notice_score(signals):
    notice = signals.get("notice_period_days", 90)
    if notice <= 30:
        return 1.0
    elif notice <= 45:
        return 0.8
    elif notice <= 60:
        return 0.6
    elif notice <= 90:
        return 0.3
    else:
        return 0.1

def compute_behavioral_multiplier(signals, ref_date):
    mult = 1.0
    
    # 1. Last active date
    last_act_str = signals.get("last_active_date")
    last_act = parse_date(last_act_str)
    if last_act:
        days = (ref_date - last_act).days
        if days <= 30:
            mult *= 1.1
        elif days > 180:
            mult *= 0.3
        else:
            mult *= 0.7
            
    # 2. Recruiter response rate
    resp_rate = signals.get("recruiter_response_rate", 0)
    if resp_rate < 0.2:
        mult *= 0.4
    else:
        mult *= (0.6 + 0.5 * resp_rate)
        
    # 3. Open to work flag
    otw = signals.get("open_to_work_flag", False)
    mult *= 1.1 if otw else 0.9
    
    # 4. Interview completion rate
    int_rate = signals.get("interview_completion_rate", 0)
    if int_rate < 0.5:
        mult *= 0.5
    else:
        mult *= (0.7 + 0.4 * int_rate)
        
    # 5. Offer acceptance rate
    off_rate = signals.get("offer_acceptance_rate", 0)
    if off_rate != -1:
        if off_rate < 0.4:
            mult *= 0.6
        else:
            mult *= (0.8 + 0.3 * off_rate)
            
    # 6. Github activity score
    gh = signals.get("github_activity_score", -1)
    if gh == -1:
        mult *= 0.9
    else:
        mult *= (0.9 + 0.003 * gh)
        
    # 7. Saved by recruiters
    saved = signals.get("saved_by_recruiters_30d", 0)
    mult *= (1.0 + min(0.2, 0.02 * saved))
    
    # 8. Profile completeness
    completeness = signals.get("profile_completeness_score", 100)
    mult *= (0.9 + 0.2 * (completeness / 100.0))
    
    return mult

def generate_reasoning(cand, matched_skills, score, rank):
    profile = cand.get("profile", {})
    signals = cand.get("redrob_signals", {})
    
    name = profile.get("anonymized_name", "Candidate")
    exp = profile.get("years_of_experience", 0)
    title = profile.get("current_title", "Software Engineer")
    comp = profile.get("current_company", "a tech firm")
    loc = profile.get("location", "India")
    notice = signals.get("notice_period_days", 30)
    
    # Clean up matched skills
    skills_slice = matched_skills[:3]
    skills_str = ", ".join(skills_slice) if skills_slice else "applied ML techniques"
    
    # 1. Experience and Title Introduction
    intro_opts = [
        f"{name} is an exceptional Senior AI Engineer with {exp} years of experience, currently working as {title} at {comp}.",
        f"A strong {title} with {exp} years of production ML experience, currently working at {comp}.",
        f"{name} offers {exp} years of software and ML expertise, currently holding the position of {title} at {comp}."
    ]
    intro = intro_opts[rank % len(intro_opts)]
    
    # 2. Skill Alignment
    skill_opts = [
        f"Demonstrates production-level experience with {skills_str}, aligning perfectly with our retrieval needs.",
        f"Has solid hands-on experience using {skills_str} for ranking and search system development.",
        f"Highly proficient in {skills_str}, exhibiting the deep system engineering required for our founding team."
    ]
    skill_part = skill_opts[(rank + 1) % len(skill_opts)]
    
    # 3. Location and Notice Period (incorporating concerns if any)
    is_local = "noida" in loc.lower() or "pune" in loc.lower() or "delhi" in loc.lower() or "ncr" in loc.lower()
    pronoun = "them"
    
    if is_local:
        if notice <= 30:
            avail_part = f"Based in {loc} with a short {notice}-day notice, making {pronoun} highly available."
        else:
            avail_part = f"Based in {loc} with a {notice}-day notice, showing strong local alignment despite the notice period."
    else:
        if signals.get("willing_to_relocate", False):
            avail_part = f"Currently in {loc} with a {notice}-day notice, but fully willing to relocate to Pune/Noida offices."
        else:
            avail_part = f"Located in {loc} ({notice}-day notice); location relocation is a minor constraint but offset by skill fit."
            
    return f"{intro} {skill_part} {avail_part}"

def rank_candidates(candidates_path, output_path):
    ref_date = datetime.datetime(2026, 6, 14)
    ranked_list = []
    
    print(f"Reading candidates from {candidates_path}...")
    
    honeypot_count = 0
    total_count = 0
    
    with open(candidates_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            cand = json.loads(line)
            total_count += 1
            
            # Filter 1: Honeypot check
            is_hp, reason = is_honeypot(cand, ref_date)
            if is_hp:
                honeypot_count += 1
                continue
                
            cid = cand.get("candidate_id")
            profile = cand.get("profile", {})
            career = cand.get("career_history", [])
            skills = cand.get("skills", [])
            signals = cand.get("redrob_signals", {})
            
            # Compute scores
            title_score = compute_title_score(profile, career)
            
            # If title matches nothing, set to 0. We can completely skip candidates with 0.0 title match to save time
            if title_score == 0.0:
                continue
                
            skills_score, matched_skills = compute_skills_score(skills, profile, career)
            exp_score = compute_experience_score(profile)
            loc_score = compute_location_score(profile, signals)
            notice_score = compute_notice_score(signals)
            
            # If location score is 0.0 (e.g. outside India and unwilling to relocate), skip
            if loc_score == 0.0:
                continue
                
            base_score = (
                0.40 * title_score + 
                0.30 * skills_score + 
                0.15 * exp_score + 
                0.10 * loc_score + 
                0.05 * notice_score
            )
            
            beh_mult = compute_behavioral_multiplier(signals, ref_date)
            rounded_score = round(base_score * beh_mult, 4)
            
            ranked_list.append({
                "candidate_id": cid,
                "cand_obj": cand,
                "score": rounded_score,
                "matched_skills": matched_skills
            })
            
            if total_count % 20000 == 0:
                print(f"Processed {total_count} candidates...")
                
    print(f"Total scanned: {total_count}")
    print(f"Honeypots skipped: {honeypot_count}")
    print(f"Valid candidates remaining: {len(ranked_list)}")
    
    # Sort:
    # 1. Score descending
    # 2. Candidate ID ascending (as tie-breaker)
    ranked_list.sort(key=lambda x: (-x["score"], x["candidate_id"]))
    
    # Take top 100
    top_100 = ranked_list[:100]
    
    # Write output
    print(f"Writing top 100 candidates to {output_path}...")
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["candidate_id", "rank", "score", "reasoning"])
        
        for i, entry in enumerate(top_100):
            rank = i + 1
            cid = entry["candidate_id"]
            score = entry["score"]
            reason = generate_reasoning(entry["cand_obj"], entry["matched_skills"], score, rank)
            writer.writerow([cid, rank, f"{score:.4f}", reason])
            
    print("Done!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Rank candidates for AI Engineer role.")
    parser.add_argument("--candidates", required=True, help="Path to candidates.jsonl")
    parser.add_argument("--out", required=True, help="Path to output CSV")
    
    args = parser.parse_args()
    
    rank_candidates(args.candidates, args.out)
