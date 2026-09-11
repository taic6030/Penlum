# Penlum — Cải tiến trải nghiệm quản trị và viết bài

Ngày: 11/09/2026. Phạm vi: mã nguồn admin và API xem trước; giữ kiến trúc Cloudflare, nội dung Markdown và dữ liệu riêng từng tenant.

## Tham khảo và quyết định

Tham khảo [WordPress](https://github.com/wordpress/wordpress) và [hướng dẫn block editor chính thức](https://wordpress.org/documentation/article/wordpress-block-editor/): vùng viết trung tâm, thanh công cụ, bảng cài đặt tài liệu, mục lục, xem trước và bước xuất bản. Penlum áp dụng cách tổ chức công việc này; không tích hợp WordPress/PHP hay mô hình lưu Gutenberg blocks.

Editor sử dụng [TOAST UI Editor](https://ui.toast.com/tui-editor/) 3.2.2 cho hai chế độ trực quan và Markdown. Tắt usage statistics. Mã editor được tải khi mở màn hình viết, không đưa lên các website public.

Dùng [Font Awesome Free](https://docs.fontawesome.com/web/setup/packages) 7.3.1, phục vụ CSS/font ngay từ static assets của Penlum. Các icon thao tác có nhãn hoặc accessible name. Toàn bộ bộ Free sẵn dùng; không cần Font Awesome Kit/CDN.

## Những điểm đã phản biện và sửa

| Vấn đề                                            | Cách sửa                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Phải khai báo nhiều trường trước khi bắt đầu      | Mở editor bằng một nút; nhập tiêu đề và viết ngay; slug tự tạo hỗ trợ tiếng Việt                                              |
| Vùng viết nhỏ, chỉ có textarea Markdown           | Vùng soạn thảo rộng, định dạng trực quan, tiêu đề phụ, danh sách, trích dẫn, liên kết, ảnh và bảng; chuyển Markdown khi cần   |
| SEO, ảnh và danh mục chia nhiều màn hình          | Bảng bên phải có Bài viết / SEO / Mục lục; chọn ảnh và thêm danh mục ngay trong editor                                        |
| Sửa bài đã xuất bản có thể tự thay đổi website    | Autosave server chỉ cho nháp. Bài đã xuất bản/lên lịch lưu bản chỉnh sửa trên máy; áp dụng bằng nút Cập nhật                  |
| Khó biết nội dung đã lưu hay chưa                 | Trạng thái Đang lưu / Đã lưu / Lưu trên máy / Lỗi, thời điểm lưu, báo lỗi ngay trên editor                                    |
| Mất nội dung khi chuyển màn hình                  | Bản khôi phục local theo user/site/post, cảnh báo rời editor, lựa chọn giữ bản trên máy và phục hồi                           |
| Xem trước đòi ghi dữ liệu                         | API POST preview nhận nội dung tạm, không sửa post/SEO/cache generation; có khung máy tính và điện thoại                      |
| Viết và quản lý lẫn lộn                           | Sidebar riêng Bài viết / Trang / Thư viện / Danh mục; danh sách có tìm kiếm, trạng thái, sắp xếp, phân trang và nhân bản nháp |
| Màn hình tổng quan ít giúp người viết             | Hiển thị nội dung vừa sửa, số lượng theo trạng thái và lối tắt đúng website đang chọn                                         |
| Menu hiện thao tác không có quyền                 | `/auth/me` trả memberships và scopes; lọc menu và các thao tác theo quyền; backend vẫn kiểm tra độc lập                       |
| Toolbar thư viện xuất hiện thêm tab Write/Preview | Ẩn toolbar mặc định, dùng thanh công cụ Penlum nhất quán                                                                      |
| Bảng SEO trên mobile bị nội dung editor chồng lên | Cô lập z-index của vùng viết, bảng cài đặt mở bên trên và đóng được                                                           |

## Kiểm tra đã thực hiện

- TypeScript: typecheck riêng Worker và browser admin.
- 35 kiểm thử: 8 core, 4 editor utilities/serialized saves, 23 tích hợp D1/R2/HTTP.
- Các kiểm thử bổ sung xác minh: slug tiếng Việt, media round-trip theo tenant, hàng đợi lưu không ghi song song và hồi phục sau lỗi; preview không sửa bài/site; membership scopes và chặn preview chéo tenant/author.
- Kiểm tra trực tiếp trên trình duyệt: đăng nhập, mở editor, nhập tiêu đề/nội dung, autosave rồi tải lại, chuyển Markdown/trực quan, mục lục, SEO, thêm danh mục, mở thư viện ảnh, xem trước desktop/mobile, xuất bản bài mẫu và cập nhật.
- Đã đối chiếu trang public khi lưu bản chỉnh sửa local: nội dung public giữ nguyên. Sau khi bấm Cập nhật, trang public nhận thay đổi.
- Rời editor với thay đổi chưa cập nhật → giữ bản trên máy → mở lại → khôi phục thành công.
- Rà soát bố cục ở 1440 × 960 và 390 × 844; sửa lớp chồng trên mobile, kiểm tra không tràn chiều rộng trang.

Bài mẫu được tạo trong môi trường local: “Một buổi sáng dành cho những ý tưởng”. Đây là nội dung demo để thử editor và xem trước.

## Giới hạn thực tế

- Khôi phục local chỉ có trên trình duyệt/máy đã viết; không phải bản nháp cộng tác được đồng bộ nhiều thiết bị. Khi bộ nhớ trình duyệt đầy/không khả dụng, giao diện báo không lưu được dự phòng.
- Version check chặn ghi đè nội dung từ phiên khác; chưa có khóa bài hay cùng biên tập thời gian thực. Có thể rời và mở lại để lấy bản máy chủ; bản local được giữ để người dùng xem lại.
- Preview chạy trong iframe sandbox, không thực thi Code Manager snippets. Preview minh họa giao diện/nội dung, không mô phỏng đầy đủ script của website.
- Nội dung và SEO dùng các endpoint riêng; khi một bước lỗi, giao diện giữ phần chưa lưu và báo lỗi để thử lại. Chưa có transaction chung cho toàn bộ document + SEO.
- Thao tác Lưu trữ bài là soft delete theo API hiện có; chưa có màn hình thùng rác/khôi phục. Saved views, revision comparison/restore UI, page builder và workflow duyệt bài vẫn nằm ngoài lần cải tiến này.
- Danh sách nội dung hiện tải các cursor rồi tìm/sort trong browser; phù hợp demo và quy mô nhỏ, cần tìm/sort/pagination phía server trước khi dùng kho nội dung lớn.
- Đây là kiểm tra trình duyệt trực tiếp và kiểm thử tự động ở tầng service/utilities; chưa có bộ browser E2E tự động hay chứng nhận WCAG. Chưa triển khai Cloudflare production.
