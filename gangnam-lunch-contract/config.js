// =====================================================================
// 강남 점심 계약 식당 고르기 설정
// - 카카오 JavaScript 키: 카카오 개발자 사이트에 등록한 도메인에서만 동작
//   (지금 등록된 곳: https://andrew010417.github.io)
// - Supabase: BioNexus 점심 고르기와 같은 프로젝트 (publishable 키만. secret / service_role 키는 절대 넣지 말 것)
// =====================================================================
const KAKAO_JS_KEY = "3c8dc162ddb82ff8fc6bf503c88c6348";
const SUPABASE_URL = "https://odpcdblxpepbauvozlbp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_syadIQAc6eXMLCBUUMQvtw_GlJ_dS5M";

// 거리 계산 기준 사무실 (지도가 주소로 정확한 좌표를 다시 찾음)
const OFFICE = {
  key: "gangnam",
  label: "강남 연구소",
  address: "서울특별시 서초구 강남대로 373",
  location: { lat: 37.4966, lon: 127.0276 },
};
