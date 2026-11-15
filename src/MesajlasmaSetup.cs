using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("MesajlasmaSetup x64")]
[assembly: AssemblyDescription("Mesajlasma Windows 10/11 x64 Kurulum Sihirbazi")]
[assembly: AssemblyCompany("Mesajlasma Projesi")]
[assembly: AssemblyProduct("MesajlasmaSetup")]
[assembly: AssemblyVersion("2.1.0.0")]

namespace MesajlasmaSetup
{
    public class SetupForm : Form
    {
        private TextBox txtServerUrl;
        private CheckBox chkDesktop;
        private CheckBox chkStartupBg;
        private Button btnInstall;
        private Label lblStatus;

        public SetupForm()
        {
            this.Text = "Mesajlaşma — Windows 10/11 (x64) Kurulum Sihirbazı";
            this.Size = new Size(540, 390);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(17, 27, 33);
            this.ForeColor = Color.FromArgb(233, 237, 239);
            this.Font = new Font("Segoe UI", 9.5f);

            Panel topBanner = new Panel
            {
                Dock = DockStyle.Top,
                Height = 72,
                BackColor = Color.FromArgb(0, 168, 132)
            };

            Label title = new Label
            {
                Text = "📥 Mesajlaşma — Masaüstü Kurulum Sihirbazı (x64)",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.White,
                AutoSize = true,
                Location = new Point(18, 14)
            };

            Label sub = new Label
            {
                Text = "Telefon Rehberi • Görüntülü/Sesli Arama • Arka Planda Çalışma Desteği",
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(230, 255, 245),
                AutoSize = true,
                Location = new Point(20, 42)
            };

            topBanner.Controls.Add(title);
            topBanner.Controls.Add(sub);
            this.Controls.Add(topBanner);

            Label lblUrl = new Label
            {
                Text = "Bağlanılacak Sunucu Adresi (Yerel veya İnternet/Bulut URL):",
                AutoSize = true,
                Location = new Point(22, 92)
            };
            this.Controls.Add(lblUrl);

            txtServerUrl = new TextBox
            {
                Text = "http://localhost:3080",
                Location = new Point(22, 118),
                Size = new Size(480, 28),
                BackColor = Color.FromArgb(42, 57, 66),
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };
            this.Controls.Add(txtServerUrl);

            chkDesktop = new CheckBox
            {
                Text = "Masaüstüne 'Mesajlaşma' uygulama kısayolu oluştur",
                Checked = true,
                AutoSize = true,
                Location = new Point(22, 164)
            };
            this.Controls.Add(chkDesktop);

            chkStartupBg = new CheckBox
            {
                Text = "Program kapatılsa bile arka planda çalışması için izin ver (Otomatik Başlat)",
                Checked = true,
                AutoSize = true,
                Location = new Point(22, 196)
            };
            this.Controls.Add(chkStartupBg);

            lblStatus = new Label
            {
                Text = "Kurulum için aşağıdaki 'Şimdi Kur ve Başlat' butonuna tıklayın.",
                AutoSize = true,
                ForeColor = Color.FromArgb(134, 150, 160),
                Location = new Point(22, 240)
            };
            this.Controls.Add(lblStatus);

            btnInstall = new Button
            {
                Text = "✅ Şimdi Kur ve Başlat",
                Location = new Point(22, 276),
                Size = new Size(480, 44),
                BackColor = Color.FromArgb(0, 168, 132),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnInstall.FlatAppearance.BorderSize = 0;
            btnInstall.Click += (s, e) => RunInstall();
            this.Controls.Add(btnInstall);
        }

        private void RunInstall()
        {
            try
            {
                string url = txtServerUrl.Text.Trim();
                if (string.IsNullOrEmpty(url)) url = "http://localhost:3080";

                string edgePath = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
                string chromePath = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
                string browserExe = File.Exists(edgePath) ? edgePath : (File.Exists(chromePath) ? chromePath : url);
                string args = (browserExe == url) ? "" : ("--app=" + url);

                if (chkDesktop.Checked)
                {
                    string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    string lnkPath = Path.Combine(desktop, "Mesajlaşma.lnk");
                    CreateShortcut(lnkPath, browserExe, args, "Mesajlaşma - Görüntülü Arama ve Mesajlaşma");
                }

                if (chkStartupBg.Checked)
                {
                    string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                    string serverExe = Path.Combine(baseDir, "MesajlasmaServer.exe");
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                    {
                        if (key != null)
                        {
                            if (File.Exists(serverExe))
                            {
                                key.SetValue("MesajlasmaArkaPlanServisi", "\"" + serverExe + "\" --background");
                            }
                            else if (!string.IsNullOrEmpty(args))
                            {
                                key.SetValue("MesajlasmaMasaustuApp", "\"" + browserExe + "\" " + args);
                            }
                        }
                    }
                }

                lblStatus.Text = "🟢 Kurulum tamamlandı! Uygulama açılıyor...";
                lblStatus.ForeColor = Color.FromArgb(34, 197, 94);

                if (!string.IsNullOrEmpty(args))
                {
                    Process.Start(browserExe, args);
                }
                else
                {
                    Process.Start(url);
                }

                MessageBox.Show(
                    "Mesajlaşma bilgisayarınıza başarıyla kuruldu!\n\n" +
                    "• Masaüstü kısayolu oluşturuldu.\n" +
                    "• Arka planda çalışma izni tanımlandı.",
                    "Kurulum Başarılı",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                this.Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Kurulum hatası: " + ex.Message, "Hata", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void CreateShortcut(string shortcutPath, string targetPath, string arguments, string description)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetPath;
                if (!string.IsNullOrEmpty(arguments)) shortcut.Arguments = arguments;
                shortcut.Description = description;
                shortcut.Save();
            }
            catch { }
        }

        [STAThread]
        public static int Main(string[] args)
        {
            if (args != null && args.Length > 0 && args[0] == "--check")
            {
                Console.WriteLine("MesajlasmaSetup.exe x64 Hazir: " + Environment.Is64BitProcess);
                return Environment.Is64BitProcess ? 0 : 1;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
            return 0;
        }
    }
}
