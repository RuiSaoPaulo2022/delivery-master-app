// 交维大师 - 全局配置
// Configuration for Delivery & Ops Master System
// 修改此文件即可适配不同公司/地区/团队

window.JW_CONFIG = {
  // ===== 基本信息 =====
  product: {
    name: "交维大师",
    nameEn: "Delivery & Ops Master",
    version: "0.2.0",
    logo: null  // null=内置Logo, 可填图片URL
  },

  // ===== 公司信息 =====
  company: {
    name: "海康威视",
    nameEn: "Hikvision",
    namePt: "Hikvision"
  },

  // ===== 区域信息 =====
  region: {
    country: "巴西",
    countryEn: "Brazil",
    countryPt: "Brasil",
    mapCenter: "巴西"
  },

  // ===== 负责人 =====
  team: {
    lead: "茹忆",
    leadTitle: "交付运维负责人",
    leadTitleEn: "Delivery & Ops Lead",
    leadTitlePt: "Líder de Entrega e Operações"
  },

  // ===== 语言 =====
  languages: ["zh", "en", "pt-BR"],
  defaultLanguage: "zh",
  languageNames: {
    "zh": "中文",
    "en": "English",
    "pt-BR": "Português"
  },

  // ===== 数据源（Excel配置模式） =====
  // 各项目目录结构在 C:\Rui-20230811\ 下
  dataSources: {
    baseDir: "C:\\Rui-20230811",
    projectManagement: "C:\\Rui-20230811\\Project Management",
    // 项目管理表命名规则：项目目录/XXX系统项目管理表_YYYYMMDD.xlsx
    projectTablePattern: "_系统项目管理表_",
    // 未关闭问题统计
    issueStats: "C:\\Rui-20230811\\Project Management\\BWC项目未关闭问题统计",
    // 巡检记录
    inspectionPattern: "巡检记录",
    // 项目列表（用于地图）
    projectMapData: "巴西项目地图_通用版_模板.xlsx"
  },

  // ===== 模块配置 =====
  modules: [
    {
      id: "project-map",
      name: "项目地图",
      nameEn: "Project Map",
      namePt: "Mapa de Projetos",
      category: "monitor",
      icon: "map",
      url: "modules/project-map.html",
      badge: "active"
    },
    {
      id: "kanban",
      name: "白板墙",
      nameEn: "Kanban Board",
      namePt: "Quadro Kanban",
      category: "monitor",
      icon: "dashboard",
      url: "modules/kanban.html",
      badge: "active"
    },
    {
      id: "inspection",
      name: "巡检助手",
      nameEn: "Inspection Assistant",
      namePt: "Assistente de Inspeção",
      category: "monitor",
      icon: "check",
      url: "#",
      badge: "plan"
    },
    {
      id: "weekly-reports",
      name: "周报系统",
      nameEn: "Weekly Reports",
      namePt: "Relatórios Semanais",
      category: "management",
      icon: "report",
      url: "modules/weekly-reports/view.html",
      badge: "active"
    },
    {
      id: "reports",
      name: "日报与统计",
      nameEn: "Daily & Reports",
      namePt: "Relatórios",
      category: "management",
      icon: "chart",
      url: "modules/reports.html",
      badge: "active",
      desc: "工作日报生成与统计报告查看（日报 + 周报）"
    },
    {
      id: "materials",
      name: "物料与资料",
      nameEn: "Materials & Assets",
      namePt: "Materiais e Ativos",
      category: "management",
      icon: "box",
      url: "#",
      badge: "soon"
    },
    {
      id: "demands",
      name: "需求跟踪",
      nameEn: "Demand Tracking",
      namePt: "Rastreamento de Demandas",
      category: "management",
      icon: "chart",
      url: "modules/demands.html",
      badge: "active"
    },
    {
      id: "feedback",
      name: "客户问题反馈",
      nameEn: "Customer Feedback",
      namePt: "Feedback do Cliente",
      category: "management",
      icon: "chat",
      url: "modules/issues.html",
      badge: "active"
    },
    {
      id: "tickets",
      name: "问题工单",
      nameEn: "Issue Ticketing",
      namePt: "Tickets de Problemas",
      category: "management",
      icon: "ticket",
      url: "modules/tickets.html",
      badge: "active"
    },
    {
      id: "license",
      name: "License管理",
      nameEn: "License Manager",
      namePt: "Gestão de Licenças",
      category: "management",
      icon: "key",
      url: "#",
      badge: "soon"
    }
  ],

  // ===== 主题色 =====
  theme: {
    primary: "#2166B2",
    primaryDark: "#1a5aa5",
    accent: "#D71920",
    bg: "#F7F8FA"
  }
};
