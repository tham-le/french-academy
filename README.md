# French Academy, B1 to C1

Nền tảng học tiếng Pháp cá nhân từ B1 lên C1 trong 12 tháng: bài học theo module, lộ trình cá nhân hoá, AI tutor (ngữ pháp, từ vựng, nói, viết, giám khảo DALF C1), theo dõi năng lực từng kỹ năng theo CEFR. Giao diện tiếng Việt, nội dung tiếng Pháp.

## Chạy

Cần Python 3.11 trở lên, không cần cài gói nào.

```
python3 server.py
```

Mở http://127.0.0.1:8000, tạo tài khoản, làm bài kiểm tra đầu vào. Dữ liệu nằm trong `data/academy.db` (SQLite) và `data/audio/`. Sao lưu bằng cách chép thư mục `data/`.

Biến môi trường: `FA_PORT` (mặc định 8000), `FA_HOST` (mặc định 127.0.0.1), `FA_DB` (đường dẫn database), `FA_MODEL` (mặc định `claude-opus-5-5`).

## Bật AI tutor

Không có khoá API, mọi chức năng AI chạy ở chế độ mô phỏng: bài nói và bài viết vẫn được lưu nhưng không có điểm, và câu trả lời của tutor được đánh dấu rõ là mô phỏng. Hệ thống không bao giờ tạo điểm giả.

```
pip install anthropic
export ANTHROPIC_API_KEY=sk-ant-...
python3 server.py
```

Phản hồi AI dùng structured output theo JSON schema (`tutor.py`), có server-side fallback khi mô hình từ chối. Phát âm không được đánh giá vì AI chỉ đọc transcript; giao diện nói rõ điều này.

## Nhận dạng giọng nói và đọc văn bản

Speaking Lab dùng Web Speech API của trình duyệt (fr-FR): Chrome và Edge hỗ trợ nhận dạng, Firefox thì không (vẫn ghi âm được, bạn gõ lại transcript). Bài nghe được đọc bằng text-to-speech của trình duyệt, nên nên cài giọng tiếng Pháp trong hệ điều hành.

## Cấu trúc

```
server.py      HTTP server và API (stdlib)
store.py       schema SQLite, auth (scrypt), nạp và kiểm tra nội dung, chấm bài
analytics.py   tiến độ, năng lực, ước tính CEFR, lịch học, báo cáo tuần và tháng
tutor.py       lớp AI: prompt theo chế độ, schema, mock mode
content/       curriculum, diagnostic, exam, resources, schedule, lessons/*.json
static/        index.html, style.css, app.js (không build)
test_smoke.py  kiểm tra API từ đầu đến cuối (python3 test_smoke.py)
test_browser.mjs  đi qua giao diện bằng headless Chrome (node test_browser.mjs)
```

Thêm bài học: tạo `content/lessons/<id>.json` theo mẫu `b1-w1-l1.json`, chạy `python3 server.py --check-content`. Bài không hợp lệ làm server từ chối khởi động.

## Tiến độ khác năng lực

Hai loại dữ liệu được lưu riêng:

- Tiến độ (bảng `lesson_progress`, `attempts`, `study_sessions`): bạn đã học gì, bao lâu.
- Năng lực (bảng `skill_assessments`): điểm từ bài kiểm tra đầu vào, câu hỏi hiểu nghe và đọc, bài nói và bài viết do AI chấm, kèm mức CEFR đã thể hiện. Ước tính CEFR lấy trung vị 60 ngày gần nhất cho mỗi kỹ năng, mức chung là kỹ năng thấp nhất, luôn kèm độ tin cậy. Hoàn thành bài học không bao giờ nâng mức.

Lỗi ngữ pháp (bảng `grammar_errors`) đến từ bài tập có gắn thẻ lỗi và từ phản hồi AI. Một lỗi lặp 3 lần trong 30 ngày sẽ đẩy bài ôn tương ứng lên đầu lộ trình và Grammar Practice tạo bài luyện từ các câu hỏi có cùng thẻ.

## Phạm vi hiện tại

Đã có: Sprint 1 (LMS lõi), Sprint 2 (module B1, 4 tuần, 16 bài, bài kiểm tra đầu vào), Sprint 3 (5 chế độ tutor, theo dõi lỗi), Sprint 4 (dashboard kỹ năng, báo cáo tuần và tháng, ước tính CEFR), Sprint 5 ở mức đầu (2 đề nói, 2 đề viết DALF C1, chấm theo grille, quy tắc sẵn sàng).

Chưa có: nội dung Phase 2 đến 4 (catalogue liệt kê module, ghi rõ chưa có bài), đề nghe và đọc DALF, phân tích phát âm từ audio.
