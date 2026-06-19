// App Initialization
document.addEventListener("DOMContentLoaded", () => {
    // Initialize Lucide Icons
    lucide.createIcons();
    
    // Tab switching
    initTabs();
    
    // Drag & Drop / File Upload Setup
    initFileUpload();
});

// Tab Manager
function initTabs() {
    const navItems = document.querySelectorAll(".nav-item");
    const tabContents = document.querySelectorAll(".tab-content");
    
    navItems.forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            const tabName = item.getAttribute("data-tab");
            
            navItems.forEach(nav => nav.classList.remove("active"));
            tabContents.forEach(content => content.classList.remove("active"));
            
            item.classList.add("active");
            document.getElementById(tabName).classList.add("active");
        });
    });
}

// Global Variables
let globalCandidates = [];
let rankedResults = [];
let scoreChart = null;
let expChart = null;

// File Upload Manager
function initFileUpload() {
    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("file-input");
    const btnBrowse = document.getElementById("btn-browse");
    
    btnBrowse.addEventListener("click", () => fileInput.click());
    
    fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) handleFile(file);
    });
    
    dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
    });
    
    dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("dragover");
    });
    
    dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    });
}

function handleFile(file) {
    const reader = new FileReader();
    const progressContainer = document.getElementById("progress-container");
    const progressFill = document.getElementById("progress-fill");
    const progressPercent = document.getElementById("progress-percent");
    const progressStatus = document.getElementById("progress-status");
    
    progressContainer.style.display = "block";
    progressFill.style.width = "0%";
    progressPercent.innerText = "0%";
    progressStatus.innerText = "Reading file...";
    
    reader.onload = function(e) {
        const text = e.target.result;
        progressStatus.innerText = "Parsing candidate records...";
        progressFill.style.width = "40%";
        progressPercent.innerText = "40%";
        
        setTimeout(() => {
            try {
                let candidates = [];
                // Check if JSON array
                if (text.trim().startsWith("[")) {
                    candidates = JSON.parse(text);
                } else {
                    // Assume JSONL
                    const lines = text.split(/\r?\n/);
                    for (let line of lines) {
                        if (line.trim()) {
                            candidates.push(JSON.parse(line));
                        }
                    }
                }
                
                globalCandidates = candidates;
                progressStatus.innerText = "Ranking candidates...";
                progressFill.style.width = "75%";
                progressPercent.innerText = "75%";
                
                setTimeout(() => {
                    runRankerPipeline();
                    progressFill.style.width = "100%";
                    progressPercent.innerText = "100%";
                    progressStatus.innerText = "Complete!";
                    
                    setTimeout(() => {
                        progressContainer.style.display = "none";
                    }, 1000);
                }, 200);
                
            } catch (err) {
                alert("Error parsing file. Please verify it is a valid candidates JSON or JSONL file. Details: " + err.message);
                progressContainer.style.display = "none";
            }
        }, 100);
    };
    
    reader.readAsText(file);
}

// ----------------------------------------------------
// Core Ranking Pipeline (JavaScript Port of rank.py)
// ----------------------------------------------------
const REF_DATE = new Date("2026-06-14");

function parseDateStr(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

function getMonthsDiff(start, end) {
    return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

function isHoneypot(cand) {
    const profile = cand.profile || {};
    const career = cand.career_history || [];
    const skills = cand.skills || [];
    
    // 1. Skill check (5+ expert/advanced with 0 duration)
    let expertWithZeroDur = 0;
    for (let s of skills) {
        const name = s.name;
        const prof = s.proficiency;
        const dur = s.duration_months || 0;
        if ((prof === "expert" || prof === "advanced") && dur === 0) {
            expertWithZeroDur++;
        }
    }
    if (expertWithZeroDur >= 5) {
        return { val: true, reason: `Skill Honeypot: ${expertWithZeroDur} skills with 0 duration` };
    }
    
    // 2. Job duration mismatch (> 6 months)
    for (let i = 0; i < career.length; i++) {
        const job = career[i];
        const start = parseDateStr(job.start_date);
        const end = parseDateStr(job.end_date);
        const durStated = job.duration_months || 0;
        
        if (start) {
            const expectedDur = end ? getMonthsDiff(start, end) : getMonthsDiff(start, REF_DATE);
            if (Math.abs(durStated - expectedDur) > 6) {
                return { val: true, reason: `Job ${i} duration mismatch: stated ${durStated} mos, expected ~${expectedDur}` };
            }
        }
    }
    
    // 3. Total experience vs sum of jobs (> 5.0 years)
    const yearsStated = profile.years_of_experience || 0;
    let sumJobMonths = 0;
    for (let job of career) {
        sumJobMonths += (job.duration_months || 0);
    }
    const sumJobYears = sumJobMonths / 12.0;
    if (Math.abs(yearsStated - sumJobYears) > 5.0) {
        return { val: true, reason: `Experience mismatch: stated ${yearsStated} yrs, sum of jobs ${sumJobYears.toFixed(1)} yrs` };
    }
    
    // 4. Job duration exceeds total experience
    for (let i = 0; i < career.length; i++) {
        const job = career[i];
        const durStatedY = (job.duration_months || 0) / 12.0;
        if (durStatedY > yearsStated + 0.5) {
            return { val: true, reason: `Job ${i} duration ${durStatedY.toFixed(1)} yrs exceeds total stated ${yearsStated} yrs` };
        }
    }
    
    return { val: false, reason: "" };
}

function computeTitleScore(profile, career) {
    const currentTitle = (profile.current_title || "").toLowerCase();
    
    const coreKeywords = [
        "ai engineer", "ml engineer", "machine learning engineer", "nlp engineer", 
        "search engineer", "retrieval engineer", "applied scientist", 
        "recommender engineer", "recommendation engineer", "applied ml", 
        "llm engineer", "ai researcher", "ml researcher"
    ];
    const subcoreKeywords = [
        "data scientist", "data science", "backend engineer", "software engineer", 
        "full stack engineer", "tech lead", "engineering manager", 
        "principal engineer", "staff engineer"
    ];
    const disqualifiedTitles = [
        "marketing", "accountant", "accounting", "mechanical", "hr manager", 
        "human resources", "operations", "sales", "graphic designer", 
        "customer support", "support specialist", "project manager", 
        "financial analyst", "content writer", "civil engineer", 
        "designer", "recruiter", "talent acquisition", "legal", 
        "account executive", "business development", "product manager", 
        "scrum master"
    ];
    
    for (let dq of disqualifiedTitles) {
        if (currentTitle.includes(dq)) return 0.0;
    }
    
    let titleScore = 0.0;
    const isCore = coreKeywords.some(kw => currentTitle.includes(kw));
    const isSubcore = subcoreKeywords.some(kw => currentTitle.includes(kw));
    
    if (isCore) {
        if (currentTitle.includes("nlp") || currentTitle.includes("search") || currentTitle.includes("retrieval")) {
            titleScore = 1.0;
        } else {
            titleScore = 0.9;
        }
    } else if (isSubcore) {
        titleScore = 0.4;
        let mlPastJobs = 0;
        for (let job of career) {
            const t = (job.title || "").toLowerCase();
            if (coreKeywords.some(kw => t.includes(kw))) {
                mlPastJobs++;
            }
        }
        titleScore = Math.min(0.8, titleScore + 0.15 * mlPastJobs);
    } else {
        if (currentTitle.includes("machine learning") || currentTitle.includes("ml") || currentTitle.includes("ai")) {
            titleScore = 0.8;
        } else {
            titleScore = 0.1;
        }
    }
    
    // Consulting check
    const consultingList = [
        "tcs", "tata consultancy", "infosys", "wipro", "accenture", 
        "cognizant", "capgemini", "tech mahindra", "hcl", "l&t", "lnt", "mindtree"
    ];
    let allConsulting = career.length > 0;
    for (let job of career) {
        const comp = (job.company || "").toLowerCase();
        const isConsult = consultingList.some(c => comp.includes(c));
        if (!isConsult) {
            allConsulting = false;
            break;
        }
    }
    if (allConsulting) titleScore *= 0.1;
    
    // Academic-only check
    const academicKeywords = ["research assistant", "teaching assistant", "phd student", "postdoc", "professor", "lecturer"];
    let allAcademic = career.length > 0;
    for (let job of career) {
        const t = (job.title || "").toLowerCase();
        const isAcad = academicKeywords.some(ak => t.includes(ak));
        if (!isAcad) {
            allAcademic = false;
            break;
        }
    }
    if (allAcademic) titleScore *= 0.1;
    
    // Job hoppers check
    if (career.length >= 3) {
        let sumDur = 0;
        for (let job of career) sumDur += (job.duration_months || 0);
        const avgTenure = sumDur / career.length;
        if (avgTenure < 18) titleScore *= 0.7;
    }
    
    return titleScore;
}

function computeSkillsScore(skills, profile, career) {
    const coreSkills = [
        "embeddings", "sentence-transformers", "bge", "e5", "vector search", 
        "pinecone", "weaviate", "qdrant", "milvus", "opensearch", "elasticsearch", 
        "faiss", "hybrid search", "ndcg", "mrr", "map", "information retrieval", 
        "ranking", "evaluation", "vector database"
    ];
    const niceToHave = [
        "lora", "qlora", "peft", "xgboost", "learning to rank", "fine-tuning", 
        "llm", "distributed systems", "pytorch", "tensorflow", "nlp", "python"
    ];
    
    let score = 0.0;
    let matchedSkills = [];
    
    for (let s of skills) {
        const name = (s.name || "").toLowerCase();
        const prof = s.proficiency || "beginner";
        const dur = s.duration_months !== undefined ? s.duration_months : 12;
        
        const profMult = { "expert": 1.0, "advanced": 0.8, "intermediate": 0.5, "beginner": 0.2 }[prof] || 0.2;
        const durMult = Math.min(36, dur) / 36.0;
        const weight = profMult * durMult;
        
        const isCore = coreSkills.some(cs => name.includes(cs));
        const isNice = niceToHave.some(nt => name.includes(nt));
        
        if (isCore) {
            score += weight * 2.0;
            matchedSkills.push(s.name);
        } else if (isNice) {
            score += weight * 1.0;
            matchedSkills.push(s.name);
        }
    }
    
    let normalized = Math.min(1.0, score / 10.0);
    
    // Keyword stuffers check
    const summary = (profile.summary || "").toLowerCase();
    let fullCareer = "";
    for (let job of career) fullCareer += " " + (job.description || "");
    const combinedText = (summary + " " + fullCareer).toLowerCase();
    
    const keywordsCheck = ["ml", "ai", "nlp", "search", "retrieval", "ranking", "embedding", "vector", "model", "algorithm", "recommend", "intelligence"];
    const hasTextMention = keywordsCheck.some(kw => combinedText.includes(kw));
    if (!hasTextMention && normalized > 0.3) {
        normalized *= 0.1;
    }
    
    // Domain check (CV only)
    const cvSkills = ["computer vision", "image classification", "speech recognition", "tts", "gans", "robotics", "yolo", "object detection"];
    const hasCv = skills.some(s => cvSkills.some(cv => (s.name || "").toLowerCase().includes(cv)));
    const hasNlp = skills.some(s => (coreSkills.concat(["nlp"])).some(cs => (s.name || "").toLowerCase().includes(cs)));
    if (hasCv && !hasNlp) {
        normalized *= 0.2;
    }
    
    return { score: normalized, matched: matchedSkills };
}

function computeExperienceScore(profile) {
    const exp = profile.years_of_experience || 0;
    if (exp >= 6.0 && exp <= 8.0) return 1.0;
    if ((exp >= 5.0 && exp < 6.0) || (exp > 8.0 && exp <= 9.0)) return 0.9;
    if ((exp >= 4.0 && exp < 5.0) || (exp > 9.0 && exp <= 10.0)) return 0.7;
    if ((exp >= 3.0 && exp < 4.0) || (exp > 10.0 && exp <= 12.0)) return 0.4;
    return 0.1;
}

function computeLocationScore(profile, signals) {
    const country = (profile.country || "").toLowerCase();
    const location = (profile.location || "").toLowerCase();
    const relocate = signals.willing_to_relocate || false;
    
    const isLocal = location.includes("noida") || location.includes("pune") || location.includes("delhi") || location.includes("gurgaon") || location.includes("ncr");
    const isTier1 = location.includes("hyderabad") || location.includes("bangalore") || location.includes("mumbai") || location.includes("chennai");
    
    if (country.includes("india") || !country) {
        if (isLocal) return 1.0;
        if (isTier1) return relocate ? 0.8 : 0.4;
        return relocate ? 0.7 : 0.2;
    } else {
        return relocate ? 0.3 : 0.0;
    }
}

function computeNoticeScore(signals) {
    const notice = signals.notice_period_days !== undefined ? signals.notice_period_days : 90;
    if (notice <= 30) return 1.0;
    if (notice <= 45) return 0.8;
    if (notice <= 60) return 0.6;
    if (notice <= 90) return 0.3;
    return 0.1;
}

function computeBehavioralMultiplier(signals) {
    let mult = 1.0;
    
    // Active date
    const lastAct = parseDateStr(signals.last_active_date);
    if (lastAct) {
        const days = Math.floor((REF_DATE.getTime() - lastAct.getTime()) / (1000 * 60 * 60 * 24));
        if (days <= 30) mult *= 1.1;
        else if (days > 180) mult *= 0.3;
        else mult *= 0.7;
    }
    
    // Response rate
    const respRate = signals.recruiter_response_rate || 0;
    if (respRate < 0.2) mult *= 0.4;
    else mult *= (0.6 + 0.5 * respRate);
    
    // Open to work
    const otw = signals.open_to_work_flag || false;
    mult *= otw ? 1.1 : 0.9;
    
    // Interview rate
    const intRate = signals.interview_completion_rate || 0;
    if (intRate < 0.5) mult *= 0.5;
    else mult *= (0.7 + 0.4 * intRate);
    
    // Offer rate
    const offRate = signals.offer_acceptance_rate !== undefined ? signals.offer_acceptance_rate : -1;
    if (offRate !== -1) {
        if (offRate < 0.4) mult *= 0.6;
        else mult *= (0.8 + 0.3 * offRate);
    }
    
    // GitHub activity
    const gh = signals.github_activity_score !== undefined ? signals.github_activity_score : -1;
    if (gh === -1) mult *= 0.9;
    else mult *= (0.9 + 0.003 * gh);
    
    // Saved by recruiters
    const saved = signals.saved_by_recruiters_30d || 0;
    mult *= (1.0 + Math.min(0.2, 0.02 * saved));
    
    // Profile completeness
    const completeness = signals.profile_completeness_score || 100;
    mult *= (0.9 + 0.2 * (completeness / 100.0));
    
    return mult;
}

function generateReasoning(cand, matchedSkills, score, rank) {
    const profile = cand.profile || {};
    const signals = cand.redrob_signals || {};
    
    const name = profile.anonymized_name || "Candidate";
    const exp = profile.years_of_experience || 0;
    const title = profile.current_title || "Software Engineer";
    const comp = profile.current_company || "a tech firm";
    const loc = profile.location || "India";
    const notice = signals.notice_period_days || 30;
    
    const skillsSlice = matchedSkills.slice(0, 3);
    const skillsStr = skillsSlice.length > 0 ? skillsSlice.join(", ") : "applied ML techniques";
    
    const introOpts = [
        `${name} is an exceptional Senior AI Engineer with ${exp} years of experience, currently working as ${title} at ${comp}.`,
        `A strong ${title} with ${exp} years of production ML experience, currently working at ${comp}.`,
        `${name} offers ${exp} years of software and ML expertise, currently holding the position of ${title} at ${comp}.`
    ];
    const intro = introOpts[rank % introOpts.length];
    
    const skillOpts = [
        `Demonstrates production-level experience with ${skillsStr}, aligning perfectly with our retrieval needs.`,
        `Has solid hands-on experience using ${skillsStr} for ranking and search system development.`,
        `Highly proficient in ${skillsStr}, exhibiting the deep system engineering required for our founding team.`
    ];
    const skillPart = skillOpts[(rank + 1) % skillOpts.length];
    
    const isLocal = loc.toLowerCase().includes("noida") || loc.toLowerCase().includes("pune") || loc.toLowerCase().includes("delhi") || loc.toLowerCase().includes("ncr");
    let availPart = "";
    
    if (isLocal) {
        if (notice <= 30) {
            availPart = `Based in ${loc} with a short ${notice}-day notice, making them highly available.`;
        } else {
            availPart = `Based in ${loc} with a ${notice}-day notice, showing strong local alignment despite the notice period.`;
        }
    } else {
        if (signals.willing_to_relocate) {
            availPart = `Currently in ${loc} with a ${notice}-day notice, but fully willing to relocate to Pune/Noida offices.`;
        } else {
            availPart = `Located in ${loc} (${notice}-day notice); location relocation is a minor constraint but offset by skill fit.`;
        }
    }
    
    return `${intro} ${skillPart} ${availPart}`;
}

function runRankerPipeline() {
    let ranked = [];
    let honeypotCount = 0;
    
    for (let cand of globalCandidates) {
        const hp = isHoneypot(cand);
        if (hp.val) {
            honeypotCount++;
            continue;
        }
        
        const profile = cand.profile || {};
        const career = cand.career_history || [];
        const skills = cand.skills || [];
        const signals = cand.redrob_signals || {};
        
        const titleScore = computeTitleScore(profile, career);
        if (titleScore === 0.0) continue;
        
        const { score: skillsScore, matched: matchedSkills } = computeSkillsScore(skills, profile, career);
        const expScore = computeExperienceScore(profile);
        const locScore = computeLocationScore(profile, signals);
        const noticeScore = computeNoticeScore(signals);
        
        if (locScore === 0.0) continue;
        
        const baseScore = (
            0.40 * titleScore + 
            0.30 * skillsScore + 
            0.15 * expScore + 
            0.10 * locScore + 
            0.05 * noticeScore
        );
        
        const behMult = computeBehavioralMultiplier(signals);
        const finalScore = baseScore * behMult;
        
        // Round to 4 decimal places just like rank.py
        const roundedScore = Math.round(finalScore * 10000) / 10000;
        
        ranked.push({
            candidate_id: cand.candidate_id,
            cand_obj: cand,
            score: roundedScore,
            matched_skills: matchedSkills
        });
    }
    
    // Sort:
    // 1. Score descending
    // 2. candidate_id ascending
    ranked.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        return a.candidate_id.localeCompare(b.candidate_id);
    });
    
    rankedResults = ranked.slice(0, 100);
    
    // Update Dashboard UI
    document.getElementById("stat-total").innerText = globalCandidates.length;
    document.getElementById("stat-valid").innerText = ranked.length;
    document.getElementById("stat-honeypots").innerText = honeypotCount;
    document.getElementById("h-total-skipped").innerText = honeypotCount;
    
    document.getElementById("results-section").style.display = "block";
    
    renderResultsTable();
    renderCharts(ranked.slice(0, 100));
}

function renderResultsTable() {
    const tbody = document.querySelector("#results-table tbody");
    tbody.innerHTML = "";
    
    rankedResults.forEach((entry, idx) => {
        const rank = idx + 1;
        const profile = entry.cand_obj.profile || {};
        const signals = entry.cand_obj.redrob_signals || {};
        const reason = generateReasoning(entry.cand_obj, entry.matched_skills, entry.score, rank);
        
        let rankClass = "";
        if (rank === 1) rankClass = "top-1";
        else if (rank === 2 || rank === 3) rankClass = "top-2";
        
        const row = document.createElement("tr");
        row.innerHTML = `
            <td><div class="rank-badge ${rankClass}">${rank}</div></td>
            <td class="name-cell">${entry.candidate_id}</td>
            <td class="score-cell">${entry.score.toFixed(4)}</td>
            <td>
                <div class="name-cell">${profile.anonymized_name || "N/A"}</div>
                <div class="company-cell">Notice: ${signals.notice_period_days} days</div>
            </td>
            <td>
                <div class="name-cell">${profile.current_title || "N/A"}</div>
                <div class="company-cell">${profile.current_company || "N/A"} (${profile.current_company_size || ""})</div>
            </td>
            <td>
                <div class="loc-cell">${profile.location || "N/A"}</div>
                <div class="notice-cell">${signals.willing_to_relocate ? "Willing to relocate" : "No relocation"}</div>
            </td>
            <td class="reasoning-cell">${reason}</td>
        `;
        tbody.appendChild(row);
    });
    
    // Trigger download action
    document.getElementById("btn-download").onclick = downloadCSV;
}

function downloadCSV() {
    let csvRows = [["candidate_id", "rank", "score", "reasoning"]];
    
    rankedResults.forEach((entry, idx) => {
        const rank = idx + 1;
        const score = entry.score.toFixed(4);
        const reason = generateReasoning(entry.cand_obj, entry.matched_skills, entry.score, rank);
        
        // Escape quotes in reasoning
        const escapedReason = reason.replace(/"/g, '""');
        csvRows.push([entry.candidate_id, rank, score, `"${escapedReason}"`]);
    });
    
    const csvContent = "data:text/csv;charset=utf-8," 
        + csvRows.map(e => e.join(",")).join("\n");
        
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "team_ai_alchemists.csv");
    document.body.appendChild(link); // Required for FF
    
    link.click();
    document.body.removeChild(link);
}

// Charts rendering (Chart.js)
function renderCharts(top100) {
    // 1. Score Chart
    const scoreCanvas = document.getElementById("scoreChart");
    const scores = top100.map(e => e.score);
    
    // Buckets
    const bands = ["1.4+", "1.2 - 1.4", "1.0 - 1.2", "0.8 - 1.0", "< 0.8"];
    const bandCounts = [0, 0, 0, 0, 0];
    
    scores.forEach(s => {
        if (s >= 1.4) bandCounts[0]++;
        else if (s >= 1.2) bandCounts[1]++;
        else if (s >= 1.0) bandCounts[2]++;
        else if (s >= 0.8) bandCounts[3]++;
        else bandCounts[4]++;
    });
    
    if (scoreChart) scoreChart.destroy();
    
    scoreChart = new Chart(scoreCanvas, {
        type: 'bar',
        data: {
            labels: bands,
            datasets: [{
                label: 'Candidate Counts',
                data: bandCounts,
                backgroundColor: ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444'],
                borderWidth: 0,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
    
    // 2. Experience Levels Chart
    const expCanvas = document.getElementById("expChart");
    const exps = top100.map(e => e.cand_obj.profile.years_of_experience || 0);
    
    const expBands = ["< 5 yrs", "5 - 7 yrs (Target)", "7 - 9 yrs (Target)", "> 9 yrs"];
    const expCounts = [0, 0, 0, 0];
    
    exps.forEach(e => {
        if (e < 5) expCounts[0]++;
        else if (e <= 7) expCounts[1]++;
        else if (e <= 9) expCounts[2]++;
        else expCounts[3]++;
    });
    
    if (expChart) expChart.destroy();
    
    expChart = new Chart(expCanvas, {
        type: 'doughnut',
        data: {
            labels: expBands,
            datasets: [{
                data: expCounts,
                backgroundColor: ['#64748b', '#8b5cf6', '#3b82f6', '#f59e0b'],
                borderWidth: 1,
                borderColor: 'rgba(255, 255, 255, 0.1)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 11 } }
                }
            }
        }
    });
}
