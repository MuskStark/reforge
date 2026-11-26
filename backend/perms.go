package main

import (
	"context"
	"net/http"
)

// actor 当前请求的行为人:系统角色 + 全局岗位
type actor struct {
	ID          string // users.id;环境变量引导的管理员没有用户行,为空
	Username    string
	DisplayName string
	SysRole     string // admin | member
	JobRole     string // 岗位代码:cto | pm | handler(BH) | dev(TH) | viewer(PMO);界面显示名见 jobRoleLabel
}

func (a *actor) isAdmin() bool { return a.SysRole == "admin" }
func (a *actor) isCTO() bool   { return a.JobRole == RoleCTO }
func (a *actor) isPMO() bool   { return a.JobRole == RoleViewer }

// isJobless 无岗位的纯提交人:只能提交收集表、看自己提交的需求进度(管理员不受此限,
// 其 jobRole 可能为空但拥有全局可见性)。各读取端点按此收口。
func (a *actor) isJobless() bool { return a.JobRole == RoleNone && !a.isAdmin() }

// joblessSees 无岗位的纯提交人能否看到这个项目:只有自己提交的;有岗位或管理员一律可见。
// 各项目级读取端点(详情/时间线/承接/导出)在返回前统一过这道闸
func joblessSees(a *actor, pr *Project) bool {
	return !a.isJobless() || pr.CreatedBy == a.ID
}

// name 时间线上显示的名字
func (a *actor) name() string {
	if a.DisplayName != "" {
		return a.DisplayName
	}
	return a.Username
}

// caps 行为人在某个项目里的有效能力。
// 系统管理员、CTO、PMO 是全局的;PM / BH / TH / PMO 成员按项目授予。
type caps struct {
	Admin   bool
	CTO     bool
	PM      bool
	Handler bool
	Dev     bool
	Viewer  bool
	PMO     bool // 岗位为 PMO:做需求承接的初级分析、指派 PM 与终审(全局生效,不需要逐项目添加)
}

func capsFor(a actor, projectRoles []string) caps {
	c := caps{Admin: a.isAdmin(), CTO: a.isCTO(), PMO: a.isPMO()}
	for _, r := range projectRoles {
		switch r {
		case RolePM:
			c.PM = true
		case RoleHandler:
			c.Handler = true
		case RoleDev:
			c.Dev = true
		case RoleViewer:
			c.Viewer = true
		}
	}
	return c
}

// member 是否项目参与者(可看可评论的范围内的人;PMO 只读)
func (c caps) member() bool { return c.Admin || c.CTO || c.PM || c.Handler || c.Dev }

// manage 能否计划与推进:改计划、提交评审、回退阶段(成员的分配另见 canAssign)
func (c caps) manage() bool { return c.Admin || c.CTO || c.PM }

// triage 能否做需求承接的初级分析:PMO 做,管理员兜底(见 intake.go)
func (c caps) triage() bool { return c.Admin || c.PMO }

// finalReview 能否做需求承接的终审:PMO 做,管理员兜底
func (c caps) finalReview() bool { return c.Admin || c.PMO }

// editFlow 能否修改流程定义(表单与流程图)。节点上的经办人最清楚流程实际怎么走,
// 所以项目里的 PM、BH、TH 都能改,管理员与 CTO 照旧;PMO 在项目里仍是只读。
func (c caps) editFlow() bool { return c.Admin || c.CTO || c.PM || c.Handler || c.Dev }

// canReview 能否在某类关卡上表决
func (c caps) canReview(reviewerRole string) bool {
	if c.Admin {
		return true
	}
	return (reviewerRole == RoleCTO && c.CTO) || (reviewerRole == RoleHandler && c.Handler)
}

// assign 能否指派 / 更换项目经理:需求承接里由 PMO 在初级分析之后指派,管理员兜底
func (c caps) assign() bool { return c.Admin || c.PMO }

// canAssign 能否增删某一类项目成员。流程的权限分配按类划分:
//
//	管理员 —— 全部;PMO —— PM(项目经理);CTO —— TH(科技经办);PM —— BH(业务经办)
//
// PMO 成员(只读)不属于任何一侧,只有管理员能添加。
func (c caps) canAssign(role string) bool {
	switch role {
	case RolePM:
		return c.assign()
	case RoleViewer:
		return c.Admin
	case RoleHandler:
		return c.Admin || c.PM
	case RoleDev:
		return c.Admin || c.CTO
	}
	return false
}

// skip 能否跳过阶段、取消项目
func (c caps) skip() bool { return c.Admin || c.CTO }

// flags 交给前端做按钮显隐的能力表(服务端仍然逐请求校验)
func (c caps) flags() map[string]bool {
	return map[string]bool{
		"view":          true,
		"manage":        c.manage(),
		"editFlow":      c.editFlow(),
		"assign":        c.assign(),
		"assignHandler": c.canAssign(RoleHandler),
		"assignDev":     c.canAssign(RoleDev),
		"assignViewer":  c.canAssign(RoleViewer),
		"skip":          c.skip(),
		"comment":       c.member(),
		"createItem":    c.member(),
		"reviewCTO":     c.canReview(RoleCTO),
		"reviewHandler": c.canReview(RoleHandler),
		"triage":        c.triage(),
		"final":         c.finalReview(),
		"isPM":          c.PM,
		"isHandler":     c.Handler,
		"isCTO":         c.CTO,
		"isPMO":         c.PMO,
		"isAdmin":       c.Admin,
	}
}

// currentActor 取当前登录人;未登录写 401 并返回 false;必须先改密码的会话写 403
func currentActor(w http.ResponseWriter, r *http.Request, st *postgresStore) (*actor, bool) {
	sd := sessions.get(bearerToken(r))
	if sd == nil {
		writeError(w, http.StatusUnauthorized, "未登录或会话已过期")
		return nil, false
	}
	if mustChangeFirst(w, sd) {
		return nil, false
	}
	a := &actor{ID: sd.UserID, Username: sd.Username, SysRole: sd.Role}
	a.DisplayName = a.Username
	if a.ID != "" {
		if u, err := st.GetUserByID(a.ID); err == nil && u != nil {
			a.JobRole, a.DisplayName = u.JobRole, displayName(u)
		}
	}
	return a, true
}

// loadCaps 解析行为人在某项目的有效能力
func loadCaps(ctx context.Context, q runner, projectID string, a *actor) (caps, error) {
	c := capsFor(*a, nil)
	rows, err := q.QueryContext(ctx, `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`, projectID, a.ID)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	var roles []string
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return c, err
		}
		roles = append(roles, r)
	}
	return capsFor(*a, roles), rows.Err()
}

func forbidden(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, "没有执行此操作的权限")
}
