package main

import (
	"encoding/json"
	"time"
)

// ---- 流程项目:端到端流程管理(架构见 docs/process-management-architecture.md)----

// 项目状态
const (
	ProjActive    = "active"
	ProjOnHold    = "on_hold"
	ProjCancelled = "cancelled"
	ProjDone      = "done"
)

// 阶段状态
const (
	StagePending    = "pending"
	StageInProgress = "in_progress"
	StageInReview   = "in_review"
	StageApproved   = "approved"
	StageSkipped    = "skipped"
)

// 项目角色(CTO 是全局岗位,不入 project_members)。
// 代码沿用历史取值不改(库里已有数据),括号里是界面上的显示名:PM 项目经理、BH 业务经办、TH 科技经办、PMO 项目管理办公室。
const (
	RolePM      = "pm"
	RoleCTO     = "cto"
	RoleHandler = "handler" // BH
	RoleDev     = "dev"     // TH
	RoleViewer  = "viewer"  // PMO
	// RoleNone 无岗位:纯提交人——只能填收集表、看自己提交的需求进度,
	// 未被处理时可改自己的提交;要参与项目须先授予岗位
	RoleNone = ""
)

// 评审单状态与评审人表决
const (
	ReviewPending   = "pending"
	ReviewApproved  = "approved"
	ReviewRejected  = "rejected"
	ReviewWithdrawn = "withdrawn"

	DecisionPending = "pending"
	DecisionApprove = "approve"
	DecisionReject  = "reject"
)

// 表决规则
const (
	ModeAll = "all" // 会签:全部通过
	ModeAny = "any" // 或签:任一通过
)

// 工作项类型
const (
	ItemTask        = "task"
	ItemDeliverable = "deliverable"
	ItemIssue       = "issue"
	ItemRisk        = "risk"
	ItemChange      = "change"
)

// 工作项状态
const (
	ItemTodo       = "todo"
	ItemInProgress = "in_progress"
	ItemBlocked    = "blocked"
	ItemInReview   = "in_review"
	ItemDone       = "done"
	ItemCancelled  = "cancelled"
)

// Project 流程项目:一个流程的一条端到端管理主线
type Project struct {
	ID           string          `json:"id"`
	ProcessID    string          `json:"processId"`
	Name         string          `json:"name"`
	Status       string          `json:"status"`
	CurrentStage int             `json:"currentStage"`
	Priority     string          `json:"priority"`
	Value        string          `json:"value"`
	Complexity   string          `json:"complexity"`
	Analysis     json.RawMessage `json:"analysis"`
	Health       string          `json:"health"`
	DueDate      string          `json:"dueDate"`
	StartedAt    *time.Time      `json:"startedAt"`
	CompletedAt  *time.Time      `json:"completedAt"`
	Version      int             `json:"version"`
	CreatedBy    string          `json:"createdBy"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`

	// ---- 需求承接(intake.go)----
	LeadPmID       string          `json:"leadPmId"`     // 主负责 PM;为空或已不是 PM 时取最早到岗的 PM
	TriageDoneAt   *time.Time      `json:"triageDoneAt"` // PMO 完成初级分析的时间
	TriageBy       string          `json:"-"`            // 完成初级分析的人(users.id)
	FinalStatus    string          `json:"finalStatus"`  // "" | pending:技术可行性评估已通过,正在等 PMO 终审
	FinalReviewID  string          `json:"-"`            // 等终审的那一轮评审
	CtoSupport     json.RawMessage `json:"ctoSupport"`   // 申请 CTO 协助的现状(CtoSupport)
	IntakePassedAt *time.Time      `json:"-"`            // PMO 终审通过、承接完成的时间;为空 = 这个项目没走完过承接(见 intakeLegacy)

	tpl []StageTemplate // 立项时的阶段模板快照(scanProject 解析;对外经 Stages 输出)
}

// ProjectStage 项目内的一个阶段(每个项目按其模板快照有 N 行)
type ProjectStage struct {
	Seq       int        `json:"seq"`
	Status    string     `json:"status"`
	EnteredAt *time.Time `json:"enteredAt"`
	ExitedAt  *time.Time `json:"exitedAt"`
	DueDate   string     `json:"dueDate"`
}

// MemberView 项目成员(联查用户)
type MemberView struct {
	UserID      string    `json:"userId"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName"`
	Role        string    `json:"role"`
	AddedAt     time.Time `json:"addedAt"`
}

// GateReview 一轮关卡评审
type GateReview struct {
	ID              string         `json:"id"`
	ProjectID       string         `json:"projectId"`
	StageSeq        int            `json:"stageSeq"`
	Round           int            `json:"round"`
	Status          string         `json:"status"`
	Summary         string         `json:"summary"`
	SubmittedBy     string         `json:"submittedBy"`
	SubmittedByName string         `json:"submittedByName"`
	SubmittedAt     time.Time      `json:"submittedAt"`
	DecidedAt       *time.Time     `json:"decidedAt"`
	Mode            string         `json:"mode"`
	ReviewerRole    string         `json:"reviewerRole"`
	Reviewers       []GateReviewer `json:"reviewers"`
}

// GateReviewer 评审人的一票
type GateReviewer struct {
	UserID      string     `json:"userId"`
	Username    string     `json:"username"`
	DisplayName string     `json:"displayName"`
	Role        string     `json:"role"`
	Decision    string     `json:"decision"`
	Comment     string     `json:"comment"`
	DecidedAt   *time.Time `json:"decidedAt"`
}

// WorkItem 工作项:任务 / 交付物 / 问题 / 风险 / 变更
type WorkItem struct {
	ID              string          `json:"id"`
	ProjectID       string          `json:"projectId"`
	ProjectName     string          `json:"projectName"`
	StageSeq        int             `json:"stageSeq"`
	Type            string          `json:"type"`
	Title           string          `json:"title"`
	Body            string          `json:"body"`
	Status          string          `json:"status"`
	Priority        string          `json:"priority"`
	AssigneeID      string          `json:"assigneeId"`
	AssigneeName    string          `json:"assigneeName"`
	AssigneeDisplay string          `json:"assigneeDisplayName"`
	ParentID        string          `json:"parentId"`
	DueDate         string          `json:"dueDate"`
	BlockReason     string          `json:"blockReason"`
	Labels          json.RawMessage `json:"labels"`
	Checklist       json.RawMessage `json:"checklist"`
	Required        bool            `json:"required"`
	DoneAt          *time.Time      `json:"doneAt"`
	SortKey         int64           `json:"sortKey"`
	Children        []WorkItem      `json:"children,omitempty"`
	Links           []ItemLink      `json:"links,omitempty"`
	CreatedBy       string          `json:"createdBy"`
	CreatedByName   string          `json:"createdByName"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	Version         int             `json:"version"`
}

// ItemLink 工作项之间的关系
type ItemLink struct {
	ToID      string `json:"toId"`
	ToTitle   string `json:"toTitle"`
	ToStatus  string `json:"toStatus"`
	Kind      string `json:"kind"`                // blocks | relates
	Direction string `json:"direction,omitempty"` // out = 我指向别人;in = 别人指向我
}

// Comment 评论、项目简报
type Comment struct {
	ID            string          `json:"id"`
	ProjectID     string          `json:"projectId"`
	ItemID        string          `json:"itemId"`
	ItemTitle     string          `json:"itemTitle"`
	ReviewID      string          `json:"reviewId"`
	Kind          string          `json:"kind"` // comment | update
	Body          string          `json:"body"`
	Structured    json.RawMessage `json:"structured"`
	Mentions      json.RawMessage `json:"mentions"`
	AuthorID      string          `json:"authorId"`
	AuthorName    string          `json:"authorName"`
	AuthorDisplay string          `json:"authorDisplayName"`
	CreatedAt     time.Time       `json:"createdAt"`
}

// ProcessVersion 流程定义的不可变快照(As-Is / To-Be / 已发布)
type ProcessVersion struct {
	ID            string          `json:"id"`
	ProcessID     string          `json:"processId"`
	ProjectID     string          `json:"projectId"`
	Version       int             `json:"version"`
	Kind          string          `json:"kind"`
	Steps         json.RawMessage `json:"steps,omitempty"`
	Metrics       json.RawMessage `json:"metrics"`
	Note          string          `json:"note"`
	CreatedBy     string          `json:"createdBy"`
	CreatedByName string          `json:"createdByName"`
	CreatedAt     time.Time       `json:"createdAt"`
}

// Event 不可变事件流(时间线 / 审计)
type Event struct {
	ID        int64           `json:"id"`
	ProjectID string          `json:"projectId"`
	Scope     string          `json:"scope"`
	TargetID  string          `json:"targetId"`
	ActorID   string          `json:"actorId"`
	ActorName string          `json:"actorName"`
	Kind      string          `json:"kind"`
	Detail    json.RawMessage `json:"detail"`
	CreatedAt time.Time       `json:"createdAt"`
}

// Notification 站内通知(按 (user_id, dedupe_key) 幂等)
type Notification struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	Kind      string     `json:"kind"`
	ProjectID string     `json:"projectId"`
	ItemID    string     `json:"itemId"`
	ReviewID  string     `json:"reviewId"`
	Title     string     `json:"title"`
	ReadAt    *time.Time `json:"readAt"`
	CreatedAt time.Time  `json:"createdAt"`
}

// ---- API 视图 ----

// StageView 阶段(带模板信息,供前端直接渲染)
type StageView struct {
	Seq          int        `json:"seq"`
	Key          string     `json:"key"`
	Name         string     `json:"name"`
	Status       string     `json:"status"`
	Gate         string     `json:"gate"`
	ReviewerRole string     `json:"reviewerRole"`
	Mode         string     `json:"mode"`
	EnteredAt    *time.Time `json:"enteredAt"`
	ExitedAt     *time.Time `json:"exitedAt"`
	DueDate      string     `json:"dueDate"`
	Rounds       int        `json:"rounds"`
}

// ItemStats 工作项统计
type ItemStats struct {
	Total        int      `json:"total"`
	Done         int      `json:"done"`
	Overdue      int      `json:"overdue"`
	Blocked      int      `json:"blocked"`
	OpenRequired int      `json:"openRequired"`
	Missing      []string `json:"missing"` // 未完成的必交付物标题
}

// HandlerHint 从流程步骤里提取的经办人员,用于立项时快速勾选
type HandlerHint struct {
	Raw         string `json:"raw"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	Matched     bool   `json:"matched"`
}

// ProjectView 项目完整视图(列表与详情共用)
type ProjectView struct {
	Project
	PendingOn    string        `json:"pendingOn"`
	Applicant    string        `json:"applicant"`
	CountersignN int           `json:"countersignN"`
	HasPM        bool          `json:"hasPm"`
	LeadPmName   string        `json:"leadPmName"`
	Stages       []StageView   `json:"stages"`
	Members      []MemberView  `json:"members"`
	Review       *GateReview   `json:"review"`
	Stats        ItemStats     `json:"stats"`
	HandlerHints []HandlerHint `json:"handlerHints"`
	Metrics      FlowMetrics   `json:"metrics"`
	// 需求承接的摘要(所处环节与三类节点数);项目的第一个阶段不是承接阶段时为 nil
	Intake *IntakeSummary  `json:"intake"`
	Can    map[string]bool `json:"can"`
}
