import subprocess
import sys
import os

def compile_tex_to_pdf(tex_file_path):
    if not os.path.exists(tex_file_path):
        print(f"Error: The file '{tex_file_path}' does not exist.")
        sys.exit(1)
        
    output_dir = os.path.dirname(tex_file_path)
    if not output_dir:
        output_dir = "."
        
    print(f"Compiling '{tex_file_path}' to PDF...")
    
    # We use pdflatex to compile the .tex file into a .pdf
    # Running it in non-interactive mode
    try:
        result = subprocess.run(
            ['pdflatex', '-interaction=nonstopmode', f'-output-directory={output_dir}', tex_file_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        
        if result.returncode == 0:
            print(f"Successfully compiled! PDF generated in: {output_dir}")
        else:
            print("Compilation failed with the following errors:")
            print(result.stdout)
            
    except FileNotFoundError:
        print("\n[!] ERROR: 'pdflatex' command not found on your system.")
        print("To compile LaTeX files into PDFs, you need a LaTeX distribution installed.")
        print("Since you are on a Mac, you can install a lightweight LaTeX distribution by running:")
        print("    brew install --cask basictex")
        print("Then restart your terminal and try running this script again.")

if __name__ == "__main__":
    # Pointing it directly to our newly generated file as default if no arguments are passed
    target_file = 'output/Ford_Analytics_Resume.tex'
    if len(sys.argv) > 1:
        target_file = sys.argv[1]
        
    compile_tex_to_pdf(target_file)
