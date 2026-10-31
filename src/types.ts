export interface SearchResult {
  title: string | null;
  url: string;
  snippet: string | null;
  content: string | null;
  content_truncated: boolean;
  score: number | null;
}

export interface SearchData {
  query: string;
  results: SearchResult[];
}

export interface PageData {
  url: string;
  final_url: string;
  title: string | null;
  description: string | null;
  content: string;
  content_length: number;
  truncated: boolean;
}

export interface CompanyResult {
  name: string | null;
  domain: string | null;
  industry: string | null;
  employee_count: string | null;
  employee_range: string | null;
  revenue_range: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  naics_codes: string[];
  naics_titles: string[];
  linkedin_industry: string[];
  score: number | null;
}

export interface CompaniesData {
  results: CompanyResult[];
  total: number;
}

export interface PeopleResult {
  name: string | null;
  title: string | null;
  seniority: string | null;
  headline: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  functional_area: string[];
  linkedin_url: string | null;
  business_email: string | null;
  business_email_risk_score: string | null;
  business_email_validated_at: string | null;
  business_email_status: string | null;
  business_email_score: number | null;
  company_name: string | null;
  company_domain: string | null;
  company_industry: string | null;
  score: number | null;
}

export interface PeopleData {
  results: PeopleResult[];
  total: number;
}

export interface ExecutionStep {
  action: string;
  provider: string;
  status: "success" | "error";
  duration_ms: number;
  error_code?: string;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface NormalizedResponse {
  request_id: string;
  status: "success" | "error" | "needs_input";
  answer: string | null;
  data: {
    results: SearchResult[];
    page: PageData | null;
    companies: CompanyResult[];
    people: PeopleResult[];
  };
  execution: ExecutionStep[];
  error?: ApiError;
  meta: {
    duration_ms: number;
    tools_used: number;
  };
}
