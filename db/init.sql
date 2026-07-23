-- Dijalankan sekali saat volume postgres pertama kali diinisialisasi.
-- Prinsip microservice: satu database terpisah per service (pertemuan 6).
CREATE DATABASE auth_db;
CREATE DATABASE product_db;
CREATE DATABASE order_db;
