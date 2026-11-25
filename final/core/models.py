from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

PipelineStatus = Literal[
    "idle",
    "running",
    "awaiting_confirmation",
    "completed",
    "cancelled",
    "error",
]
DeliverableFormat = Literal["html", "pdf", "docx", "md"]
TaskStatus = Literal[
    "detected",
    "downloaded",
    "analyzed",
    "solved",
    "synced",
    "awaiting_drive_confirm",
    "reference",
    "no_submission",
    "error",
]


@dataclass
class AulesProfile:
    base_url: str
    username: str
    full_name: str
    last_connected_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AulesProfile":
        return cls(
            base_url=str(data.get("base_url", "")),
            username=str(data.get("username", "")),
            full_name=str(data.get("full_name", "")),
            last_connected_at=str(data.get("last_connected_at", "")),
        )


@dataclass
class AulesSession:
    base_url: str
    username: str
    full_name: str
    cookies: dict[str, str] = field(default_factory=dict)
    sesskey: str | None = None
    connected_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AulesSession":
        return cls(
            base_url=str(data.get("base_url", "")),
            username=str(data.get("username", "")),
            full_name=str(data.get("full_name", "")),
            cookies=dict(data.get("cookies") or {}),
            sesskey=data.get("sesskey"),
            connected_at=str(data.get("connected_at", "")),
        )


@dataclass
class AttachmentRecord:
    id: str
    name: str
    source_url: str
    mime_type: str
    byte_size: int
    downloaded: bool
    extracted_text: str = ""
    local_cache_key: str | None = None
    drive_file_id: str | None = None
    drive_web_view_link: str | None = None
    source_type: str = "assignment"  # assignment | course_resource | student_submission | user_attachment

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AttachmentRecord":
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "archivo")),
            source_url=str(data.get("source_url", "")),
            mime_type=str(data.get("mime_type", "application/octet-stream")),
            byte_size=int(data.get("byte_size", 0) or 0),
            downloaded=bool(data.get("downloaded", False)),
            extracted_text=str(data.get("extracted_text", "")),
            local_cache_key=data.get("local_cache_key"),
            drive_file_id=data.get("drive_file_id"),
            drive_web_view_link=data.get("drive_web_view_link"),
            source_type=str(data.get("source_type", "assignment")),
        )


@dataclass
class TaskDeliverables:
    requirement_analysis_md: str
    study_notes_md: str
    homework_solution_md: str
    output_format: str = "pdf"
    deliverable_html: str | None = None
    context_sources_used: list[str] = field(default_factory=list)
    generated_at: str = ""
    model_used: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskDeliverables":
        return cls(
            requirement_analysis_md=str(data.get("requirement_analysis_md", "")),
            study_notes_md=str(data.get("study_notes_md", "")),
            homework_solution_md=str(data.get("homework_solution_md", "")),
            output_format=str(data.get("output_format", "pdf")),
            deliverable_html=data.get("deliverable_html"),
            context_sources_used=list(data.get("context_sources_used") or []),
            generated_at=str(data.get("generated_at", "")),
            model_used=str(data.get("model_used", "")),
        )


@dataclass
class TaskRecord:
    id: str
    course_id: str
    course_name: str
    title: str
    url: str
    due_date: str | None
    submission_status: str
    description_text: str
    status: str = "detected"
    is_submitted_in_aules: bool | None = None
    requires_online_submission: bool | None = True
    submitted_work_text: str | None = None
    export_formats: list[str] = field(default_factory=list)
    attachments: list[AttachmentRecord] = field(default_factory=list)
    deliverables: TaskDeliverables | None = None
    error_message: str | None = None
    drive_folder_id: str | None = None
    drive_folder_link: str | None = None
    drive_files: list[dict[str, str]] = field(default_factory=list)
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskRecord":
        deliv_raw = data.get("deliverables")
        return cls(
            id=str(data.get("id", "")),
            course_id=str(data.get("course_id", "")),
            course_name=str(data.get("course_name", "")),
            title=str(data.get("title", "")),
            url=str(data.get("url", "")),
            due_date=data.get("due_date"),
            submission_status=str(data.get("submission_status", "Pendiente")),
            description_text=str(data.get("description_text", "")),
            status=str(data.get("status", "detected")),
            is_submitted_in_aules=data.get("is_submitted_in_aules"),
            requires_online_submission=data.get("requires_online_submission", True),
            submitted_work_text=data.get("submitted_work_text"),
            export_formats=list(data.get("export_formats") or []),
            attachments=[AttachmentRecord.from_dict(a) for a in (data.get("attachments") or [])],
            deliverables=TaskDeliverables.from_dict(deliv_raw) if isinstance(deliv_raw, dict) else None,
            error_message=data.get("error_message"),
            drive_folder_id=data.get("drive_folder_id"),
            drive_folder_link=data.get("drive_folder_link"),
            drive_files=list(data.get("drive_files") or []),
            updated_at=str(data.get("updated_at", "")),
        )


@dataclass
class CourseRecord:
    id: str
    name: str
    shortname: str
    url: str
    resource_count: int = 0
    task_count: int = 0
    last_scanned_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CourseRecord":
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            shortname=str(data.get("shortname", "")),
            url=str(data.get("url", "")),
            resource_count=int(data.get("resource_count", 0) or 0),
            task_count=int(data.get("task_count", 0) or 0),
            last_scanned_at=str(data.get("last_scanned_at", "")),
        )


@dataclass
class SubjectKnowledge:
    course_id: str
    course_name: str
    summary: str
    student_work_style: str = ""
    student_preferred_formats: list[str] = field(default_factory=lambda: ["pdf"])
    key_concepts: list[str] = field(default_factory=list)
    evaluation_criteria: list[str] = field(default_factory=list)
    study_tips: list[str] = field(default_factory=list)
    glossary: list[dict[str, str]] = field(default_factory=list)
    learned_task_ids: list[str] = field(default_factory=list)
    updated_at: str = ""
    drive_file_id: str | None = None
    drive_web_view_link: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SubjectKnowledge":
        return cls(
            course_id=str(data.get("course_id", "")),
            course_name=str(data.get("course_name", "")),
            summary=str(data.get("summary", "")),
            student_work_style=str(data.get("student_work_style", "")),
            student_preferred_formats=list(data.get("student_preferred_formats") or ["pdf"]),
            key_concepts=list(data.get("key_concepts") or []),
            evaluation_criteria=list(data.get("evaluation_criteria") or []),
            study_tips=list(data.get("study_tips") or []),
            glossary=list(data.get("glossary") or []),
            learned_task_ids=list(data.get("learned_task_ids") or []),
            updated_at=str(data.get("updated_at", "")),
            drive_file_id=data.get("drive_file_id"),
            drive_web_view_link=data.get("drive_web_view_link"),
        )


@dataclass
class PipelineStageState:
    index: int
    title: str
    description: str
    status: str = "pending"
    completed_items: int = 0
    total_items: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PipelineStageState":
        return cls(
            index=int(data.get("index", 1)),
            title=str(data.get("title", "")),
            description=str(data.get("description", "")),
            status=str(data.get("status", "pending")),
            completed_items=int(data.get("completed_items", 0) or 0),
            total_items=int(data.get("total_items", 0) or 0),
        )


@dataclass
class PipelineLogEntry:
    id: str
    timestamp: str
    stage: int
    level: str
    message: str
    detail: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PipelineLogEntry":
        return cls(
            id=str(data.get("id", "")),
            timestamp=str(data.get("timestamp", "")),
            stage=int(data.get("stage", 1)),
            level=str(data.get("level", "info")),
            message=str(data.get("message", "")),
            detail=data.get("detail"),
        )


@dataclass
class PipelineRun:
    id: str
    uid: str
    status: str
    current_stage: int
    overall_progress: int
    current_item_label: str
    started_at: str
    finished_at: str | None = None
    stages: list[PipelineStageState] = field(default_factory=list)
    logs: list[PipelineLogEntry] = field(default_factory=list)
    error_message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PipelineRun":
        return cls(
            id=str(data.get("id", "")),
            uid=str(data.get("uid", "local")),
            status=str(data.get("status", "idle")),
            current_stage=int(data.get("current_stage", 1)),
            overall_progress=int(data.get("overall_progress", 0) or 0),
            current_item_label=str(data.get("current_item_label", "")),
            started_at=str(data.get("started_at", "")),
            finished_at=data.get("finished_at"),
            stages=[PipelineStageState.from_dict(s) for s in (data.get("stages") or [])],
            logs=[PipelineLogEntry.from_dict(l) for l in (data.get("logs") or [])],
            error_message=data.get("error_message"),
        )


@dataclass
class UserAgentStore:
    uid: str = "local"
    email: str = ""
    aules_profile: AulesProfile | None = None
    encrypted_aules_session: str | None = None
    encrypted_drive_oauth: str | None = None
    selected_model: str = "llama-3.3-70b-versatile"
    auto_sync_enabled: bool = False
    auto_sync_interval_minutes: int = 30
    drive_root_folder_id: str | None = None
    drive_root_folder_link: str | None = None
    courses: list[CourseRecord] = field(default_factory=list)
    course_resources: dict[str, list[AttachmentRecord]] = field(default_factory=dict)
    tasks: list[TaskRecord] = field(default_factory=list)
    knowledge: dict[str, SubjectKnowledge] = field(default_factory=dict)
    runs: list[PipelineRun] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "uid": self.uid,
            "email": self.email,
            "aules_profile": self.aules_profile.to_dict() if self.aules_profile else None,
            "encrypted_aules_session": self.encrypted_aules_session,
            "encrypted_drive_oauth": self.encrypted_drive_oauth,
            "selected_model": self.selected_model,
            "auto_sync_enabled": self.auto_sync_enabled,
            "auto_sync_interval_minutes": self.auto_sync_interval_minutes,
            "drive_root_folder_id": self.drive_root_folder_id,
            "drive_root_folder_link": self.drive_root_folder_link,
            "courses": [c.to_dict() for c in self.courses],
            "course_resources": {
                k: [a.to_dict() for a in v] for k, v in self.course_resources.items()
            },
            "tasks": [t.to_dict() for t in self.tasks],
            "knowledge": {k: v.to_dict() for k, v in self.knowledge.items()},
            "runs": [r.to_dict() for r in self.runs],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UserAgentStore":
        prof = data.get("aules_profile")
        raw_res = data.get("course_resources") or {}
        raw_kb = data.get("knowledge") or {}
        return cls(
            uid=str(data.get("uid", "local")),
            email=str(data.get("email", "")),
            aules_profile=AulesProfile.from_dict(prof) if isinstance(prof, dict) else None,
            encrypted_aules_session=data.get("encrypted_aules_session"),
            encrypted_drive_oauth=data.get("encrypted_drive_oauth"),
            selected_model=str(data.get("selected_model") or "llama-3.3-70b-versatile"),
            auto_sync_enabled=bool(data.get("auto_sync_enabled", False)),
            auto_sync_interval_minutes=int(data.get("auto_sync_interval_minutes", 30) or 30),
            drive_root_folder_id=data.get("drive_root_folder_id"),
            drive_root_folder_link=data.get("drive_root_folder_link"),
            courses=[CourseRecord.from_dict(c) for c in (data.get("courses") or [])],
            course_resources={
                str(k): [AttachmentRecord.from_dict(a) for a in (v or [])]
                for k, v in raw_res.items()
            },
            tasks=[TaskRecord.from_dict(t) for t in (data.get("tasks") or [])],
            knowledge={
                str(k): SubjectKnowledge.from_dict(v) for k, v in raw_kb.items() if isinstance(v, dict)
            },
            runs=[PipelineRun.from_dict(r) for r in (data.get("runs") or [])],
        )
