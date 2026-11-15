using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("MesajlasmaServer x64")]
[assembly: AssemblyDescription("Cok Platformlu Guvenli Mesajlasma Sunucusu ve Arka Plan Servisi (Windows 10/11 x64)")]
[assembly: AssemblyCompany("Mesajlasma Projesi")]
[assembly: AssemblyProduct("MesajlasmaServer")]
[assembly: AssemblyVersion("2.1.0.0")]

namespace MesajlasmaApp
{
    public class MainForm : Form
    {
        private Process serverProcess;
        private Label lblStatus;
        private Label lblArch;
        private TextBox txtLanUrl;
        private TextBox txtLogs;
        private Button btnOpenApp;
        private Button btnBgPerm;
        private Button btnFirewall;
        private NotifyIcon trayIcon;
        private ContextMenu trayMenu;
        private string appDir;
        private int httpPort = 3080;
        private int httpsPort = 3443;
        private bool allowFullExit = false;
        private bool startInBackground = false;

        public MainForm(bool backgroundMode)
        {
            startInBackground = backgroundMode;
            appDir = AppDomain.CurrentDomain.BaseDirectory;
            InitializeUi();
            EnsureBackgroundPermission(true);
            StartNodeServer();

            if (startInBackground)
            {
                this.WindowState = FormWindowState.Minimized;
                this.ShowInTaskbar = false;
                this.Load += (s, e) => this.Hide();
            }
        }

        private void InitializeUi()
        {
            this.Text = "Mesajlaşma — Masaüstü & Arka Plan Sunucu Yöneticisi (Windows 10/11 x64)";
            this.Size = new Size(700, 520);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(17, 27, 33);
            this.ForeColor = Color.FromArgb(233, 237, 239);
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;

            Panel headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 76,
                BackColor = Color.FromArgb(32, 44, 51),
                Padding = new Padding(18, 12, 18, 12)
            };

            Label lblTitle = new Label
            {
                Text = "🟢 Mesajlaşma — Windows x64 & Arka Plan Çalışma Yöneticisi",
                Font = new Font("Segoe UI", 12.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(34, 197, 94),
                AutoSize = true,
                Location = new Point(18, 12)
            };

            lblArch = new Label
            {
                Text = string.Format("Mimari: {0}-bit İşletim Sistemi / {1}-bit İşlem • Pencere Kapatılsa Bile Arka Planda Çalışır",
                    Environment.Is64BitOperatingSystem ? "64" : "32",
                    Environment.Is64BitProcess ? "64" : "32"),
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(134, 150, 160),
                AutoSize = true,
                Location = new Point(18, 42)
            };

            headerPanel.Controls.Add(lblTitle);
            headerPanel.Controls.Add(lblArch);
            this.Controls.Add(headerPanel);

            lblStatus = new Label
            {
                Text = "● Sunucu ve Arka Plan Durumu: Başlatılıyor...",
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                ForeColor = Color.FromArgb(34, 197, 94),
                AutoSize = true,
                Location = new Point(20, 90)
            };
            this.Controls.Add(lblStatus);

            Label lblLan = new Label
            {
                Text = "Bilgisayar ve Cep Telefonu Bağlantı Adresleri:",
                AutoSize = true,
                Location = new Point(20, 118),
                ForeColor = Color.FromArgb(200, 210, 215)
            };
            this.Controls.Add(lblLan);

            string localIp = GetLocalIPv4();
            txtLanUrl = new TextBox
            {
                ReadOnly = true,
                Multiline = true,
                Location = new Point(20, 142),
                Size = new Size(644, 52),
                BackColor = Color.FromArgb(11, 20, 26),
                ForeColor = Color.FromArgb(56, 189, 248),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 10f, FontStyle.Bold),
                Text = string.Format(
                    "Bilgisayar : http://localhost:{0}   |   Telefon (Wi-Fi): http://{1}:{0}\r\nGüvenli HTTPS (Görüntülü Arama İçin): https://{1}:{2}",
                    httpPort, localIp, httpsPort)
            };
            this.Controls.Add(txtLanUrl);

            btnOpenApp = new Button
            {
                Text = "💻 Mesajlaşma'yı Aç",
                Location = new Point(20, 206),
                Size = new Size(200, 40),
                BackColor = Color.FromArgb(0, 168, 132),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnOpenApp.FlatAppearance.BorderSize = 0;
            btnOpenApp.Click += (s, e) => OpenAppWindow();
            this.Controls.Add(btnOpenApp);

            btnBgPerm = new Button
            {
                Text = "🔔 Arka Plan Çalışma İzni Ver",
                Location = new Point(230, 206),
                Size = new Size(220, 40),
                BackColor = Color.FromArgb(42, 57, 66),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            btnBgPerm.FlatAppearance.BorderSize = 0;
            btnBgPerm.Click += (s, e) => EnsureBackgroundPermission(false);
            this.Controls.Add(btnBgPerm);

            btnFirewall = new Button
            {
                Text = "🛡️ Güvenlik Duvarı İzni Ver",
                Location = new Point(460, 206),
                Size = new Size(204, 40),
                BackColor = Color.FromArgb(42, 57, 66),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            btnFirewall.FlatAppearance.BorderSize = 0;
            btnFirewall.Click += (s, e) => ConfigureFirewall();
            this.Controls.Add(btnFirewall);

            Label lblLogs = new Label
            {
                Text = "Canlı Sunucu ve Arka Plan Kayıtları (Logs):",
                AutoSize = true,
                Location = new Point(20, 258),
                ForeColor = Color.FromArgb(134, 150, 160)
            };
            this.Controls.Add(lblLogs);

            txtLogs = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Location = new Point(20, 282),
                Size = new Size(644, 180),
                BackColor = Color.FromArgb(11, 20, 26),
                ForeColor = Color.FromArgb(209, 213, 219),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 9f)
            };
            this.Controls.Add(txtLogs);

            // Sistem Tepsisi (System Tray) Menüsü
            trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add("💻 Mesajlaşma Uygulamasını Aç", (s, e) => OpenAppWindow());
            trayMenu.MenuItems.Add("⚙️ Sunucu Yönetim Panelini Göster", (s, e) => ShowMainWindow());
            trayMenu.MenuItems.Add("-");
            trayMenu.MenuItems.Add("🚪 Tamamen Kapat (Çıkış)", (s, e) =>
            {
                allowFullExit = true;
                trayIcon.Visible = false;
                StopNodeServer();
                Application.Exit();
            });

            trayIcon = new NotifyIcon
            {
                Text = "Mesajlaşma (Arka Planda Aktif - x64)",
                Icon = SystemIcons.Shield,
                ContextMenu = trayMenu,
                Visible = true
            };
            trayIcon.DoubleClick += (s, e) => ShowMainWindow();

            // Pencere kapatıldığında (X tuşu) programı kapatma, arka plana küçült!
            this.FormClosing += (s, e) =>
            {
                if (!allowFullExit && e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    this.Hide();
                    trayIcon.ShowBalloonTip(
                        3000,
                        "Mesajlaşma Arka Planda Çalışıyor",
                        "Program kapatılsa bile arka planda gelen mesaj ve aramaları almaya devam eder. Tamamen çıkmak için tepsi ikonuna sağ tıklayın.",
                        ToolTipIcon.Info
                    );
                }
                else
                {
                    trayIcon.Visible = false;
                    StopNodeServer();
                }
            };
        }

        private void ShowMainWindow()
        {
            this.Show();
            this.ShowInTaskbar = true;
            this.WindowState = FormWindowState.Normal;
            this.Activate();
        }

        private void EnsureBackgroundPermission(bool silent)
        {
            try
            {
                string exePath = Assembly.GetExecutingAssembly().Location;
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (key != null)
                    {
                        key.SetValue("MesajlasmaArkaPlanServisi", "\"" + exePath + "\" --background");
                    }
                }
                AppendLog("Arka planda çalışma ve Windows açılışında otomatik başlatma izni tanımlandı.");
                if (!silent)
                {
                    MessageBox.Show(
                        "Arka planda çalışma izni başarıyla etkinleştirildi!\n\n" +
                        "1. Bu pencereyi (X) ile kapatsanız bile program sağ alt köşede (Sistem Tepsisi) arka planda çalışmaya devam eder.\n" +
                        "2. Bilgisayarınız yeniden başladığında otomatik olarak arka planda açılır.",
                        "Arka Planda Çalışma İzni Aktif",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                }
            }
            catch (Exception ex)
            {
                AppendLog("Arka plan izni uyarısı: " + ex.Message);
            }
        }

        public static string FindNodeExecutable(string baseDir)
        {
            string localNode = Path.Combine(baseDir, "node.exe");
            if (File.Exists(localNode)) return localNode;

            string pfNode = @"C:\Program Files\nodejs\node.exe";
            if (File.Exists(pfNode)) return pfNode;

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string wingetPackages = Path.Combine(localAppData, @"Microsoft\WinGet\Packages");
            if (Directory.Exists(wingetPackages))
            {
                string[] found = Directory.GetFiles(wingetPackages, "node.exe", SearchOption.AllDirectories);
                if (found.Length > 0) return found[0];
            }

            return "node.exe";
        }

        private void AppendLog(string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            if (this.InvokeRequired)
            {
                this.BeginInvoke(new Action<string>(AppendLog), line);
                return;
            }
            txtLogs.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line + Environment.NewLine);
        }

        private void StartNodeServer()
        {
            try
            {
                string nodeExe = FindNodeExecutable(appDir);
                string serverJs = Path.Combine(appDir, "server.js");

                if (!File.Exists(serverJs))
                {
                    AppendLog("HATA: server.js bulunamadı: " + serverJs);
                    lblStatus.Text = "● Hata: server.js bulunamadı";
                    lblStatus.ForeColor = Color.Red;
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = nodeExe,
                    Arguments = "\"" + serverJs + "\"",
                    WorkingDirectory = appDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };

                serverProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
                serverProcess.OutputDataReceived += (s, e) => AppendLog(e.Data);
                serverProcess.ErrorDataReceived += (s, e) => AppendLog(e.Data);
                serverProcess.Start();
                serverProcess.BeginOutputReadLine();
                serverProcess.BeginErrorReadLine();

                lblStatus.Text = "🟢 Sunucu ve Arka Plan Servisi: Aktif (PID: " + serverProcess.Id + " • Windows x64)";
                lblStatus.ForeColor = Color.FromArgb(34, 197, 94);
                AppendLog("Node.js x64 motoru arka planda başlatıldı: " + nodeExe);
            }
            catch (Exception ex)
            {
                lblStatus.Text = "🔴 Sunucu Başlatılamadı";
                lblStatus.ForeColor = Color.Red;
                AppendLog("Başlatma hatası: " + ex.Message);
            }
        }

        private void StopNodeServer()
        {
            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    serverProcess.Kill();
                    serverProcess.WaitForExit(2000);
                }
            }
            catch { }
        }

        private void OpenAppWindow()
        {
            string url = "http://localhost:" + httpPort;
            try
            {
                string edgePath = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
                if (File.Exists(edgePath))
                {
                    Process.Start(edgePath, "--app=" + url);
                    return;
                }
            }
            catch { }
            Process.Start(url);
        }

        private void ConfigureFirewall()
        {
            try
            {
                string batPath = Path.Combine(appDir, "GuvenlikDuvari_IzinVer.bat");
                if (File.Exists(batPath))
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = batPath,
                        Verb = "runas",
                        UseShellExecute = true
                    };
                    Process.Start(psi);
                    AppendLog("Windows Güvenlik Duvarı izin betiği çalıştırıldı.");
                }
            }
            catch (Exception ex)
            {
                AppendLog("Güvenlik duvarı işlemi iptal edildi: " + ex.Message);
            }
        }

        public static string GetLocalIPv4()
        {
            try
            {
                var host = Dns.GetHostEntry(Dns.GetHostName());
                foreach (var ip in host.AddressList)
                {
                    if (ip.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip))
                    {
                        string s = ip.ToString();
                        if (s.StartsWith("192.168.") || s.StartsWith("10.") || s.StartsWith("172."))
                            return s;
                    }
                }
            }
            catch { }
            return "127.0.0.1";
        }
    }

    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            if (args != null && args.Length > 0 && args[0] == "--check")
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                Console.WriteLine("MesajlasmaServer.exe Dogrulama Basarili!");
                Console.WriteLine("Mimari (64-bit Process): " + Environment.Is64BitProcess);
                Console.WriteLine("Mimari (64-bit OS)     : " + Environment.Is64BitOperatingSystem);
                Console.WriteLine("Calisma Klasoru        : " + baseDir);
                Console.WriteLine("Bulunan Node.exe       : " + MainForm.FindNodeExecutable(baseDir));
                Console.WriteLine("Yerel LAN IP           : " + MainForm.GetLocalIPv4());
                return Environment.Is64BitProcess ? 0 : 1;
            }

            bool bgMode = (args != null && args.Length > 0 && args[0] == "--background");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(bgMode));
            return 0;
        }
    }
}
